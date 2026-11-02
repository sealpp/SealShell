use tauri::{Emitter, Manager};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
        ICoreWebView2WebMessageReceivedEventArgs2,
    },
    WebMessageReceivedEventHandler, take_pwstr,
};
use windows::core::{Interface, PWSTR};

/// Keep WebView2's HTML drop handler. Only resolve the native objects supplied by
/// a DOM drop; replacing its OLE target would break Dockview and tree dragging.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let window = app.get_webview_window("main").expect("main window");
    let origin = app_origin(app.handle());
    let events = window.clone();
    window.with_webview(move |platform| unsafe {
        let webview = platform.controller().CoreWebView2().expect("WebView2");
        let mut token = 0;
        webview
            .add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut message = PWSTR::null();
                    args.WebMessageAsJson(&mut message)?;
                    let encoded = take_pwstr(message);
                    let Ok(encoded) = serde_json::from_str::<String>(&encoded) else {
                        return Ok(());
                    };
                    let Ok(message) = serde_json::from_str::<serde_json::Value>(&encoded) else {
                        return Ok(());
                    };
                    if message["type"] != "sealshell:resolve-file-drop" {
                        return Ok(());
                    }
                    let mut source = PWSTR::null();
                    args.Source(&mut source)?;
                    let source = take_pwstr(source);
                    if tauri::Url::parse(&source).map(|url| url.origin().ascii_serialization()).ok().as_ref() != Some(&origin) {
                        return Ok(());
                    }
                    let result = paths(&args);
                    let payload = match result {
                        Ok(paths) => serde_json::json!({"id":message["id"], "paths":paths}),
                        Err(error) => serde_json::json!({"id":message["id"], "error":format!("无法读取拖入项目的本机路径：{error}")}),
                    };
                    let _ = events.emit("file-drop-paths", payload);
                    Ok(())
                })),
                &mut token,
            )
            .expect("register file drop path resolver");
        // WebView2 owns this subscription until the window's controller closes.
    })
}

fn app_origin(app: &tauri::AppHandle) -> String {
    if cfg!(debug_assertions)
        && let Some(url) = &app.config().build.dev_url
    {
        return url.origin().ascii_serialization();
    }
    "http://tauri.localhost".into()
}

pub fn initialize(webview: &tauri::Webview) {
    if webview
        .url()
        .map(|url| url.origin().ascii_serialization())
        .ok()
        != Some(app_origin(webview.app_handle()))
    {
        return;
    }
    // Use a valid, acknowledged Tauri message so Wry's existing listener can
    // process it too. Keep the invoke key inside the same kind of closure as
    // Tauri's own IPC initialization, never in a JS-readable property.
    let script = include_str!("file_drop.js").replace(
        "__INVOKE_KEY__",
        &serde_json::to_string(webview.app_handle().invoke_key()).unwrap(),
    );
    let _ = webview.eval(script);
}

unsafe fn paths(
    args: &ICoreWebView2WebMessageReceivedEventArgs,
) -> windows::core::Result<Vec<String>> {
    unsafe {
        let objects = args
            .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
            .AdditionalObjects()?;
        let mut count = 0;
        objects.Count(&mut count)?;
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let file = objects
                .GetValueAtIndex(index)?
                .cast::<ICoreWebView2File>()?;
            let mut path = PWSTR::null();
            file.Path(&mut path)?;
            paths.push(take_pwstr(path));
        }
        Ok(paths)
    }
}
