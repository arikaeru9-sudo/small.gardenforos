// === 仮想OSのコアロジック ===
const VFS = { '/': { type: 'dir', content: {} } };
let currentDir = '/';
let worker = null;
let outputDiv, inputBox, promptSpan, fileInput, uploadBtn, countdownDiv;
let editorContainer, editorTextarea, editorFilenameSpan, saveBtn, exitBtn;
let currentEditFile = null;

// === ユーティリティ関数 ===
function log(message, type = 'output') {
    if (!outputDiv) {
        console.error('致命的なエラー: ログコンソールが初期化されていません。');
        return;
    }
    const lines = message.split('\n');
    lines.forEach(line => {
        outputDiv.innerHTML += `<div class="${type}">${line}</div>`;
    });
    outputDiv.scrollTop = outputDiv.scrollHeight;
}

function updatePrompt() {
    if (!promptSpan || !inputBox) return;
    promptSpan.innerText = `guest@ephemeral-os:${currentDir}$`;
    inputBox.focus();
}

function setUIState(enabled) {
    if (!inputBox || !uploadBtn) return;
    inputBox.disabled = !enabled;
    uploadBtn.disabled = !enabled;
    if (enabled) {
        inputBox.focus();
    }
}

function showCountdown(message) {
    if (!countdownDiv) return;
    countdownDiv.textContent = message;
    countdownDiv.style.display = 'block';
}

function hideCountdown() {
    if (!countdownDiv) return;
    countdownDiv.style.display = 'none';
}

function resolvePath(path) {
    let parts = path.split('/').filter(p => p !== '');
    if (!path.startsWith('/')) {
        parts = currentDir.split('/').filter(p => p !== '').concat(parts);
    }
    const resolvedParts = [];
    for (const part of parts) {
        if (part === '..') {
            if (resolvedParts.length > 0) {
                resolvedParts.pop();
            }
        } else if (part !== '.') {
            resolvedParts.push(part);
        }
    }
    return '/' + resolvedParts.join('/');
}

function getDir(path) {
    if (path === '/') {
        return VFS['/'];
    }
    const parts = path.split('/').filter(p => p !== '');
    let current = VFS['/'].content;
    for (const part of parts) {
        if (!current[part] || current[part].type !== 'dir') {
            return null;
        }
        current = current[part].content;
    }
    return current;
}

function getFile(path) {
    const parts = path.split('/').filter(p => p !== '');
    const fileName = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parentDir = getDir(parentPath);
    return parentDir ? parentDir.content[fileName] : null;
}

function createFile(path, content, type = 'file') {
    const resolvedPath = resolvePath(path);
    const parentPath = resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || '/';
    const name = resolvedPath.split('/').pop();
    let parentDir = getDir(parentPath);
    if (!parentDir) {
        return false;
    }
    parentDir.content[name] = { type, content };
    return true;
}

function toSerializableVFS(vfs) {
    const newVFS = JSON.parse(JSON.stringify(vfs));
    function traverse(node) {
        if (node.type === 'file' && node.content instanceof Uint8Array) {
            node.content = Array.from(node.content);
        } else if (node.type === 'dir') {
            for (const key in node.content) {
                traverse(node.content[key]);
            }
        }
    }
    traverse(newVFS['/']);
    return newVFS;
}

function main_vfs_sync(workerVFS) {
    function recursiveSync(workerNode, mainNode) {
        for (const key in mainNode.content) {
            if (!workerNode['/'].content[key]) {
                delete mainNode.content[key];
            }
        }
        for (const key in workerNode['/'].content) {
            const workerItem = workerNode['/'].content[key];
            if (workerItem.type === 'dir') {
                if (!mainNode.content[key] || mainNode.content[key].type !== 'dir') {
                    mainNode.content[key] = { type: 'dir', content: {} };
                }
                recursiveSync({ '/': { type: 'dir', content: { [key]: workerItem } } }, mainNode.content[key]);
            } else if (workerItem.type === 'file') {
                mainNode.content[key] = { type: 'file', content: new Uint8Array(workerItem.content) };
            }
        }
    }
    recursiveSync(workerVFS, VFS['/']);
}

function runPythonCode(code, filePath) {
    if (!worker) {
        log('Python環境がロードされていません。`load_pyodide`コマンドを実行してください。', 'error');
        return;
    }
    setUIState(false);
    showCountdown('Pythonコードを実行中...');
    const serializableVFS = toSerializableVFS(VFS);
    worker.postMessage({
        type: 'run_python',
        code: code,
        filePath: filePath,
        vfs: serializableVFS
    });
}

function setupUpload() {
    if (!uploadBtn || !fileInput) return;
    uploadBtn.addEventListener('click', () => {
        fileInput.click();
    });
    fileInput.addEventListener('change', (event) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        for (const file of files) {
            const reader = new FileReader();
            const fileName = file.name;
            reader.onload = (e) => {
                const content = e.target.result;
                const filePath = resolvePath(currentDir + '/' + fileName);
                const isText = typeof content === 'string';
                if (createFile(filePath, isText ? new TextEncoder().encode(content) : new Uint8Array(content))) {
                    log(`ファイルがアップロードされました: ${filePath}`);
                } else {
                    log(`エラー: ファイル ${filePath} のアップロードに失敗しました。`, 'error');
                }
            };
            const extension = fileName.split('.').pop().toLowerCase();
            const binaryExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'mp3', 'wav', 'ogg', 'aac', 'flac', 'mp4', 'webm', 'mov', 'zip', 'rar', '7z', 'gz', 'tar', 'iso', 'dmg'];
            if (binaryExtensions.includes(extension)) {
                reader.readAsArrayBuffer(file);
            } else {
                reader.readAsText(file, 'UTF-8');
            }
        }
    });
}

function openEditor(filePath) {
    if (!editorContainer || !editorTextarea || !editorFilenameSpan || !saveBtn || !exitBtn) {
        log('エラー: エディタのHTML要素が初期化されていません。', 'error');
        return;
    }
    let file = getFile(filePath);
    if (!file) {
        createFile(filePath, new Uint8Array());
        file = getFile(filePath);
        log(`ファイルが作成されました: ${filePath}`);
    }
    if (file.type !== 'file') {
        log(`エラー: 編集できません。パスはディレクトリです。`, 'error');
        return;
    }
    let fileContent = file.content;
    let isText = false;
    try {
        fileContent = new TextDecoder("utf-8").decode(file.content);
        isText = true;
    } catch(e) {
        fileContent = 'バイナリファイルは編集できません。';
    }
    editorContainer.style.display = 'flex';
    if (isText) {
        editorTextarea.value = fileContent;
        editorTextarea.disabled = false;
        saveBtn.disabled = false;
    } else {
        editorTextarea.value = fileContent;
        editorTextarea.disabled = true;
        saveBtn.disabled = true;
    }
    editorFilenameSpan.textContent = filePath;
    currentEditFile = file;
    editorTextarea.focus();
    inputBox.style.display = 'none';
    promptSpan.style.display = 'none';
}

function setupEditor() {
    if (!saveBtn || !exitBtn) return;
    saveBtn.addEventListener('click', () => {
        if (currentEditFile) {
            const textEncoder = new TextEncoder();
            currentEditFile.content = textEncoder.encode(editorTextarea.value);
            log(`ファイルが保存されました: ${editorFilenameSpan.textContent}`);
        }
        closeEditor();
    });
    exitBtn.addEventListener('click', () => {
        closeEditor();
    });
}

function closeEditor() {
    if (!editorContainer || !inputBox || !promptSpan) return;
    editorContainer.style.display = 'none';
    inputBox.style.display = 'block';
    promptSpan.style.display = 'block';
    setUIState(true);
    updatePrompt();
}

function zipDirectory(zip, dir, path) {
    if (typeof JSZip === 'undefined') {
        log('エラー: ZIPライブラリ(JSZip)がロードされていません。', 'error');
        return;
    }
    for (const name in dir.content) {
        const item = dir.content[name];
        const fullPath = (path === '') ? name : `${path}/${name}`;
        if (item.type === 'dir') {
            zip.folder(fullPath);
            zipDirectory(zip, item, fullPath);
        } else if (item.type === 'file') {
            zip.file(fullPath, item.content);
        }
    }
}

async function createZip() {
    if (typeof JSZip === 'undefined' || typeof saveAs === 'undefined') {
        log('エラー: ZIPライブラリまたはファイルセーバーがロードされていません。', 'error');
        return;
    }
    log('仮想ファイルシステムをZIP化中...', 'progress');
    const zip = new JSZip();
    zipDirectory(zip, VFS['/'], '');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    saveAs(zipBlob, 'ephemeral-os-snapshot.zip');
    log('ZIPファイルが生成され、ダウンロードが開始されました。', 'success');
}

const executeHandler = async (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        const command = inputBox.value.trim();
        inputBox.value = '';
        log(`<span class="prompt">${promptSpan.innerText}</span> ${command}`);
        await executeCommand(command);
        updatePrompt();
    }
};

async function executeCommand(command) {
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    let result = '';
    setUIState(false);
    try {
        switch (cmd) {
            case 'ls': {
                const targetDir = getDir(currentDir);
                const files = Object.keys(targetDir.content);
                result = files.join('   ') || 'ファイルが見つかりません。';
                break;
            }
            case 'cd': {
                const targetPath = args[0] ? resolvePath(args[0]) : '/';
                const targetDir = getDir(targetPath);
                if (targetDir) {
                    currentDir = targetPath;
                } else {
                    result = `エラー: ディレクトリが見つからないか、ファイルです: ${targetPath}`;
                }
                break;
            }
            case 'mkdir': {
                const newDirPath = resolvePath(args[0]);
                if (createFile(newDirPath, { type: 'dir', content: {} }, 'dir')) {
                    result = `ディレクトリが作成されました: ${newDirPath}`;
                } else {
                    result = `エラー: ディレクトリの作成に失敗しました。`;
                }
                break;
            }
            case 'cat': {
                const filePath = resolvePath(args[0]);
                const file = getFile(filePath);
                if (file && file.type === 'file') {
                    try {
                        const textContent = new TextDecoder('utf-8').decode(file.content);
                        result = textContent;
                    } catch(e) {
                        result = `エラー: このファイルはバイナリファイルのため、内容を表示できません。`;
                    }
                } else {
                    result = `エラー: ファイルが見つからないか、ディレクトリです: ${filePath}`;
                }
                break;
            }
            case 'edit': {
                if (args.length === 0) {
                    result = '使い方: edit <ファイル名>';
                } else {
                    const filePath = resolvePath(args[0]);
                    openEditor(filePath);
                    return;
                }
                break;
            }
            case 'zip': {
                await createZip();
                result = '';
                break;
            }
            case 'load_pyodide': {
                if (worker) {
                    result = 'Python環境はすでにロードされています。';
                } else {
                    log('Pyodide環境をロード中...', 'output');
                    showCountdown('Pyodideをロード中... これには数秒かかります');
                    
                    worker = new Worker('worker.js');
                    worker.addEventListener('message', (event) => {
                        const message = event.data;
                        if (message.type === 'pyodide_ready') {
                            log('2. Pyodide環境の準備が完了しました！🐍', 'output');
                            hideCountdown();
                            setUIState(true);
                            updatePrompt();
                        } else if (message.type === 'pyodide_log') {
                            log(message.content, message.logType);
                        } else if (message.type === 'python_result') {
                            log(message.content);
                            if (message.vfs) {
                                main_vfs_sync(message.vfs);
                            }
                            hideCountdown();
                            setUIState(true);
                            updatePrompt();
                        }
                    });
                    worker.postMessage({ type: 'init_pyodide' });
                    return;
                }
                break;
            }
            case 'python': {
                const scriptPath = args[0] ? resolvePath(args[0]) : null;
                if (!scriptPath) {
                    result = '使い方: python <ファイル名>';
                    break;
                }
                const file = getFile(scriptPath);
                if (file && file.type === 'file') {
                    try {
                        const code = new TextDecoder('utf-8').decode(file.content);
                        await runPythonCode(code, scriptPath);
                        result = '';
                    } catch (e) {
                        result = `エラー: スクリプトは無効なテキストファイルです。`;
                    }
                } else {
                    result = `エラー: Pythonスクリプトが見つからないか、ディレクトリです: ${scriptPath}`;
                }
                break;
            }
            case 'help':
                result = `利用可能なコマンド:
                ls          - 現在のディレクトリのファイルをリスト表示
                cd <dir>    - ディレクトリの変更
                mkdir <dir> - 新しいディレクトリの作成
                cat <file>  - ファイルの内容を表示
                edit <file> - ファイルエディタを開く
                upload      - デバイスからファイルをアップロード
                zip         - 仮想ファイルシステムをzipファイルとしてダウンロード
                load_pyodide- Pyodide環境を有効化
                python <file>- Pythonスクリプトを実行
                clear       - 画面をクリア`;
                break;
            case 'clear':
                outputDiv.innerHTML = '';
                result = '';
                break;
            default:
                result = `コマンドが見つかりません: ${cmd}`;
        }
    } catch (e) {
        result = `エラーが発生しました: ${e.message}`;
    }
    if (result) log(result);
    setUIState(true);
}

// === 初期化関数 ===
async function init() {
    try {
        outputDiv = document.getElementById('output');
        inputBox = document.getElementById('input-command');
        promptSpan = document.getElementById('prompt-span');
        fileInput = document.getElementById('file-input');
        uploadBtn = document.getElementById('upload-btn');
        editorContainer = document.getElementById('editor-container');
        editorTextarea = document.getElementById('editor-textarea');
        editorFilenameSpan = document.getElementById('editor-filename');
        saveBtn = document.getElementById('save-btn');
        exitBtn = document.getElementById('exit-btn');
        countdownDiv = document.getElementById('countdown');
        
        if (!outputDiv || !inputBox || !promptSpan) {
            throw new Error("主要なHTML要素が見つかりません。IDが正しいことを確認してください。");
        }

        log('Ephemeral OSへようこそ！"help"と入力して利用可能なコマンドを確認してください。');
        log('Pyodideを有効にするには、`load_pyodide`を実行してください。');
        updatePrompt();
        
        inputBox.addEventListener('keydown', executeHandler);
        setupUpload();
        setupEditor();
    } catch (error) {
        console.error('致命的な初期化エラー:', error);
        alert('致命的な初期化エラーが発生しました。');
    }
}

document.addEventListener('DOMContentLoaded', init);
