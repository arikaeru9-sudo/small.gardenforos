importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js");

let pyodideInstance = null;

function syncVFS(vfsData) {
    if (!pyodideInstance) return;
    try {
        pyodideInstance.FS.rmdir('/vfs', { recursive: true });
    } catch (e) {}
    pyodideInstance.FS.mkdir('/vfs');

    function traverseVFS(dir, currentPath) {
        for (const name in dir.content) {
            const item = dir.content[name];
            const fullPath = (currentPath === '/') ? `/vfs/${name}` : `${currentPath}/${name}`;
            if (item.type === 'dir') {
                try {
                    pyodideInstance.FS.mkdir(fullPath);
                    self.postMessage({ type: 'pyodide_log', content: `  -> ディレクトリ作成: ${fullPath}`, logType: 'progress' });
                    traverseVFS(item.content, fullPath);
                } catch(e) {}
            } else if (item.type === 'file') {
                const contentAsBytes = new Uint8Array(item.content);
                pyodideInstance.FS.writeFile(fullPath, contentAsBytes);
                self.postMessage({ type: 'pyodide_log', content: `  -> ファイル書き込み: ${fullPath}`, logType: 'progress' });
            }
        }
    }
    traverseVFS(vfsData['/'].content, '/');
}

function getLocalVFS() {
    const vfs = { '/': { type: 'dir', content: {} } };
    function traversePyodideFS(pyodideDir, localDir) {
        for (const name of pyodideDir) {
            if (name === '.' || name === '..') continue;
            const fullPath = pyodideDir.getPath(name);
            const stat = pyodideInstance.FS.stat(fullPath);
            if (pyodideInstance.FS.isDir(stat.mode)) {
                localDir.content[name] = { type: 'dir', content: {} };
                traversePyodideFS(pyodideInstance.FS.lookupPath(fullPath).node.contents, localDir.content[name]);
            } else {
                const content = pyodideInstance.FS.readFile(fullPath);
                localDir.content[name] = { type: 'file', content: Array.from(content) };
            }
        }
    }
    traversePyodideFS(pyodideInstance.FS.lookupPath('/vfs').node.contents, vfs['/']);
    return vfs;
}

self.onmessage = async (event) => {
    const { type, code, filePath, vfs } = event.data;
    if (type === 'init_pyodide') {
        try {
            self.postMessage({ type: 'pyodide_log', content: 'Pyodideをロード中...', logType: 'progress' });
            pyodideInstance = await loadPyodide();
            
            // === 修正箇所: 確実な文字列エスケープによる単一行記述 ===
            pyodideInstance.runPython(
                "import sys, io\\n" +
                "sys.stdout = io.StringIO()\\n" +
                "sys.stderr = io.StringIO()"
            );
            // ===================================================
            
            self.postMessage({ type: 'pyodide_ready' });
        } catch (error) {
            self.postMessage({ type: 'pyodide_log', content: `Pyodideのロード中にエラーが発生しました: ${error.message}`, logType: 'error' });
            self.postMessage({ type: 'pyodide_log', content: `詳細: ${error.stack || error.toString()}`, logType: 'error' });
        }
    } else if (type === 'run_python') {
        let result = '';
        try {
            self.postMessage({ type: 'pyodide_log', content: '仮想ファイルシステムをPyodideに同期中...', logType: 'progress' });
            syncVFS(vfs);
            self.postMessage({ type: 'pyodide_log', content: 'Pythonスクリプトを実行中...', logType: 'progress' });
            const scriptDir = pyodideInstance.FS.dirname('/vfs' + filePath);
            pyodideInstance.runPython(`import os\nos.chdir('${scriptDir}')`);
            await pyodideInstance.runPythonAsync(code);
            
            const stdout = pyodideInstance.runPython('sys.stdout.getvalue()');
            const stderr = pyodideInstance.runPython('sys.stderr.getvalue()');
            result = stdout + stderr;
            pyodideInstance.runPython('sys.stdout.seek(0); sys.stdout.truncate(0)');
            pyodideInstance.runPython('sys.stderr.seek(0); sys.stderr.truncate(0)');

            self.postMessage({ type: 'pyodide_log', content: '実行完了。出力を収集しています。', logType: 'progress' });
            const updatedVFS = getLocalVFS();
            self.postMessage({ type: 'python_result', content: result, vfs: updatedVFS });
        } catch (error) {
            const stderr = pyodideInstance.runPython('sys.stderr.getvalue()');
            pyodideInstance.runPython('sys.stdout.seek(0); sys.stdout.truncate(0)');
            pyodideInstance.runPython('sys.stderr.seek(0); sys.stderr.truncate(0)');
            result = `Python実行中にエラーが発生しました。\n${stderr || error.stack || error.toString()}`;
            self.postMessage({ type: 'python_result', content: result });
        }
    }
};
