(() => {
  const invokeKey = __INVOKE_KEY__
  Object.defineProperty(window, '__SEALSHELL_FILE_DROP__', {
    value(files, id) {
      if (!window.chrome.webview.postMessageWithAdditionalObjects) {
        throw new Error('当前 WebView2 不支持读取拖入文件的本机路径')
      }
      const callback = window.__TAURI_INTERNALS__.transformCallback(() => {}, true)
      try {
        window.chrome.webview.postMessageWithAdditionalObjects(JSON.stringify({
          cmd: 'file_drop_ack', callback, error: callback, payload: {},
          __TAURI_INVOKE_KEY__: invokeKey,
          type: 'sealshell:resolve-file-drop', id,
        }), files)
      } catch (error) {
        window.__TAURI_INTERNALS__.unregisterCallback(callback)
        throw error
      }
    },
  })
})()
