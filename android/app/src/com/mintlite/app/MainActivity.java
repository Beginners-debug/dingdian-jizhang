package com.mintlite.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * MintLite WebView shell.
 *
 * The PWA is shipped inside the APK under assets/www and is served through a fake
 * https origin (https://appassets.androidplatform.net/). Serving it over https instead of
 * file:// keeps the page in a "secure context" so localStorage / IndexedDB / service workers
 * persist between launches - file:// origins are opaque and get their storage wiped.
 *
 * No AndroidX, no Gradle: this single Activity plus android.app.* is the whole app.
 */
public class MainActivity extends Activity {

    private static final String TAG = "MintLite";

    /** Fake origin bound to the packaged assets. */
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/index.html";
    private static final String ASSET_ROOT = "www";
    private static final String STATE_URL = "ml.url";

    /** Asked on every back press: the SPA returns true when it consumed the gesture. */
    private static final String BACK_PROBE_JS =
            "(function(){try{return !!(window.MintLiteBack && window.MintLiteBack());}catch(e){return false;}})()";

    /** Reminder channel, shared with the PWA through window.MintLiteBridge (contract 4.7). */
    private static final String CHANNEL_ID = "mintlite_reminder";
    private static final String CHANNEL_NAME = "\u8fd8\u6b3e\u63d0\u9192";
    private static final String CHANNEL_DESC = "\u8d26\u5355\u5230\u671f\u4e0e\u8fd8\u6b3e\u63d0\u9192";
    private static final int NOTIFY_ID = 1001;
    private static final int REQ_POST_NOTIFICATIONS = 3301;

    private WebView webView;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        if (!assetExists(ASSET_ROOT + "/index.html")) {
            root.addView(buildErrorView("assets/www/index.html missing.\nThe APK was built without the web bundle."));
            setContentView(root);
            Log.e(TAG, "assets/" + ASSET_ROOT + "/index.html is missing");
            return;
        }

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // chrome://inspect over adb - harmless in release, very handy while wiring the PWA.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        configure(webView);
        // Must be registered before the first loadUrl, otherwise the PWA's feature detection
        // (window.MintLiteBridge) runs against an empty window and reminders never fire.
        webView.addJavascriptInterface(new Bridge(), "MintLiteBridge");
        root.addView(webView);
        setContentView(root);

        boolean restored = false;
        if (savedInstanceState != null) {
            if (webView.restoreState(savedInstanceState) != null) {
                restored = true;
            }
        }
        if (restored) {
            return;
        }
        String lastUrl = savedInstanceState == null ? null : savedInstanceState.getString(STATE_URL);
        webView.loadUrl(TextUtils.isEmpty(lastUrl) ? START_URL : lastUrl);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView == null) {
            return;
        }
        webView.saveState(outState);
        String url = webView.getUrl();
        if (!TextUtils.isEmpty(url)) {
            outState.putString(STATE_URL, url);
        }
    }

    @Override
    protected void onRestoreInstanceState(Bundle savedInstanceState) {
        super.onRestoreInstanceState(savedInstanceState);
        // restoreState() already ran in onCreate(); nothing else to rehydrate here.
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("MintLiteBridge");
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.stopLoading();
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) {
                parent.removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * Hardware back (and the gesture-nav back) asks the page first: window.MintLiteBack() returns
     * true when the SPA consumed it (closed a sheet, popped a route) and false when the user is
     * already at the root. At the root the whole task goes to the background - not finish() - so
     * the WebView state survives and tapping the icon returns to the same page.
     *
     * <p>evaluateJavascript() is asynchronous, hence the callback; anything other than the exact
     * string "true" (including "null" when no page is loaded yet) counts as "nothing to consume".
     */
    @Override
    public void onBackPressed() {
        if (webView == null) {
            moveTaskToBack(true);
            return;
        }
        webView.evaluateJavascript(BACK_PROBE_JS, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (!"true".equals(value)) {
                    moveTaskToBack(true);
                }
            }
        });
    }

    // --------------------------------------------------------------- webview setup

    private void configure(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadsImagesAutomatically(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        view.setBackgroundColor(Color.WHITE);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setWebViewClient(new AssetClient());
    }

    /** Serves https://appassets.androidplatform.net/* straight out of assets/www. */
    private final class AssetClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (request == null) {
                return null;
            }
            Uri uri = request.getUrl();
            return uri == null ? null : intercept(uri.toString(), request.getMethod());
        }

        @Override
        @SuppressWarnings("deprecation")
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            return intercept(url, "GET");
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null || request.getUrl() == null) {
                return false;
            }
            return handleExternal(request.getUrl().toString());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleExternal(url);
        }
    }

    /**
     * Top-level navigation policy (v1.2 hardening).
     *
     * <p>Only our packaged assets origin renders inside this WebView. Every other http(s) page -
     * plus mailto:, tel:, intent:, market: ... - is handed to the system. The reason is the JS
     * bridge: {@code addJavascriptInterface} is WebView-wide, so whatever page loads here would
     * inherit {@code MintLiteBridge}. Keeping foreign documents out of the WebView is what makes
     * exposing the bridge acceptable at all.
     */
    private boolean handleExternal(String url) {
        if (url == null) {
            return false;
        }
        String lower = url.toLowerCase(Locale.US);
        if (isOwnOrigin(lower)) {
            return false; // our own SPA - keep routing in-app
        }
        if (lower.startsWith("about:") || lower.startsWith("data:")) {
            return false; // internal plumbing pages, nothing to hand to the browser
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "no handler for " + url);
        }
        return true;
    }

    /** True for https://appassets.androidplatform.net, /path, ?query or #hash - nothing else. */
    private static boolean isOwnOrigin(String lowerUrl) {
        if (!lowerUrl.startsWith(ORIGIN)) {
            return false;
        }
        if (lowerUrl.length() == ORIGIN.length()) {
            return true;
        }
        char next = lowerUrl.charAt(ORIGIN.length());
        return next == '/' || next == '?' || next == '#';
    }

    // ------------------------------------------------------------- asset resolving

    private WebResourceResponse intercept(String url, String method) {
        if (url == null) {
            return null;
        }
        if (!url.startsWith(ORIGIN + "/")) {
            return null; // real network, let the WebView handle it
        }
        String path = url.substring(ORIGIN.length());
        int cut = path.indexOf('?');
        if (cut >= 0) {
            path = path.substring(0, cut);
        }
        cut = path.indexOf('#');
        if (cut >= 0) {
            path = path.substring(0, cut);
        }
        path = Uri.decode(path);
        if (path.length() == 0 || path.endsWith("/")) {
            path = path + "index.html";
        }
        if (path.startsWith("/")) {
            path = path.substring(1);
        }
        if (path.contains("..")) {
            return notFound(path, "path traversal blocked");
        }

        String assetPath = ASSET_ROOT + "/" + path;
        InputStream in = openAsset(assetPath);
        if (in == null && path.indexOf('.') < 0) {
            // SPA deep link: no extension -> let the app router handle /reports etc.
            InputStream index = openAsset(ASSET_ROOT + "/index.html");
            if (index != null) {
                return respond("text/html", index, "no-cache");
            }
        }
        if (in == null) {
            return notFound(path, method);
        }
        return respond(mimeOf(assetPath), in, "no-cache");
    }

    private InputStream openAsset(String assetPath) {
        try {
            AssetManager am = getAssets();
            return am.open(assetPath);
        } catch (IOException e) {
            return null;
        }
    }

    private boolean assetExists(String assetPath) {
        InputStream in = openAsset(assetPath);
        if (in == null) {
            return false;
        }
        try {
            in.close();
        } catch (IOException ignored) {
            // nothing useful to do
        }
        return true;
    }

    private WebResourceResponse respond(String mime, InputStream body, String cacheControl) {
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", cacheControl);
        headers.put("Access-Control-Allow-Origin", "*");
        String encoding = isBinary(mime) ? null : "utf-8";
        return new WebResourceResponse(mime, encoding, 200, "OK", headers, body);
    }

    private WebResourceResponse notFound(String path, String reason) {
        Log.w(TAG, "404 " + path + " (" + reason + ")");
        byte[] body = ("404 Not Found: " + path).getBytes(Charset.forName("UTF-8"));
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
                new ByteArrayInputStream(body));
    }

    private static boolean isBinary(String mime) {
        return mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")
                || mime.startsWith("font/") || mime.equals("application/octet-stream")
                || mime.equals("application/zip") || mime.equals("application/wasm");
    }

    /** Hand-rolled table: WebView's default guessing is unreliable for .js/.mjs/.webmanifest. */
    private static String mimeOf(String assetPath) {
        int dot = assetPath.lastIndexOf('.');
        String ext = dot < 0 ? "" : assetPath.substring(dot + 1).toLowerCase(Locale.US);
        if (ext.equals("html") || ext.equals("htm")) return "text/html";
        if (ext.equals("js") || ext.equals("mjs")) return "text/javascript";
        if (ext.equals("css")) return "text/css";
        if (ext.equals("json")) return "application/json";
        if (ext.equals("webmanifest")) return "application/manifest+json";
        if (ext.equals("map")) return "application/json";
        if (ext.equals("svg")) return "image/svg+xml";
        if (ext.equals("png")) return "image/png";
        if (ext.equals("jpg") || ext.equals("jpeg")) return "image/jpeg";
        if (ext.equals("webp")) return "image/webp";
        if (ext.equals("gif")) return "image/gif";
        if (ext.equals("ico")) return "image/x-icon";
        if (ext.equals("woff")) return "font/woff";
        if (ext.equals("woff2")) return "font/woff2";
        if (ext.equals("ttf")) return "font/ttf";
        if (ext.equals("otf")) return "font/otf";
        if (ext.equals("txt")) return "text/plain";
        if (ext.equals("xml")) return "text/xml";
        if (ext.equals("wasm")) return "application/wasm";
        if (ext.equals("mp3")) return "audio/mpeg";
        if (ext.equals("mp4")) return "video/mp4";
        String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return guessed == null ? "application/octet-stream" : guessed;
    }

    // ------------------------------------------------------------------ JS bridge

    /**
     * Shell bridge exposed as window.MintLiteBridge.
     *
     * <p>v1.2 added reminders (docs/CONTRACT-v1.2.md 4.7): the PWA owns the schedule, works out
     * due_date / days_left itself and calls {@code notify(title, body)} at most once a day; this
     * side only puts that text on the notification shade - no alarms, no background service.
     *
     * <p>v1.2.1 added {@code exitApp()} plus the {@code MintLiteBack()} contract so a swipe or a
     * back press at the root actually leaves the app instead of being swallowed.
     *
     * <p>Every method runs on WebView's JavaScript-bridge thread, so anything that has to touch
     * the Activity (UI, runtime permission dialog) is bounced onto the UI thread first.
     */
    public final class Bridge {

        /** Lets the PWA tell the shell apart from a plain browser. */
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        /** Post one reminder. Safe to call from any page load; dropped if permission is missing. */
        @JavascriptInterface
        public void notify(String title, String body) {
            postNotification(title, body);
        }

        /** Asks for POST_NOTIFICATIONS on Android 13+. Only ever called from JS, never on start. */
        @JavascriptInterface
        public void requestNotifyPermission() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    askNotifyPermission();
                }
            });
        }

        /**
         * Leaves the app: the task goes to the background, the Activity is NOT finished, so the
         * WebView keeps its page and storage and tapping the launcher icon resumes right where the
         * user was. Bound to the "root page" back gesture by window.MintLiteBack() on the JS side.
         */
        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    moveTaskToBack(true);
                }
            });
        }
    }

    private void postNotification(final String title, final String body) {
        final String safeTitle = TextUtils.isEmpty(title) ? "MintLite" : title.trim();
        final String safeBody = body == null ? "" : body.trim();
        if (safeBody.length() == 0) {
            Log.w(TAG, "notify() called without body, ignored");
            return;
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                showNotification(safeTitle, safeBody);
            }
        });
    }

    private boolean canPostNotifications() {
        if (Build.VERSION.SDK_INT < 33) {
            return true; // POST_NOTIFICATIONS only exists from Android 13 (API 33)
        }
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void showNotification(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) {
            Log.w(TAG, "no NotificationManager, notification dropped");
            return;
        }
        if (!canPostNotifications()) {
            Log.w(TAG, "POST_NOTIFICATIONS not granted, notification dropped: " + title);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ensureChannel(nm);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE; // required from API 31, legal from 23
        }
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, pendingFlags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
            builder.setPriority(Notification.PRIORITY_DEFAULT);
        }
        builder.setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .setContentIntent(tap);
        nm.notify(NOTIFY_ID, builder.build());
        Log.i(TAG, "notification posted: " + title);
    }

    /** Channels are immutable once created, so only the first call wins. */
    private void ensureChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        if (nm.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(CHANNEL_DESC);
        channel.enableLights(false);
        channel.enableVibration(true);
        nm.createNotificationChannel(channel);
    }

    private void askNotifyPermission() {
        if (Build.VERSION.SDK_INT < 33) {
            Log.i(TAG, "SDK " + Build.VERSION.SDK_INT + " needs no notification permission");
            return;
        }
        if (canPostNotifications()) {
            Log.i(TAG, "POST_NOTIFICATIONS already granted");
            return;
        }
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS },
                REQ_POST_NOTIFICATIONS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_POST_NOTIFICATIONS) {
            return;
        }
        boolean granted = grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        Log.i(TAG, "POST_NOTIFICATIONS granted=" + granted);
        if (!granted) {
            Toast.makeText(this, "\u672a\u5f00\u542f\u901a\u77e5\u6743\u9650\uff0c\u63d0\u9192\u4e0d\u4f1a\u5f39\u51fa",
                    Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------------------ error page

    private View buildErrorView(String message) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(48, 96, 48, 48);
        box.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("MintLite");
        title.setTextSize(26f);
        title.setTextColor(Color.parseColor("#2E7D6F"));
        box.addView(title);

        TextView body = new TextView(this);
        body.setText(message);
        body.setTextSize(15f);
        body.setTextColor(Color.parseColor("#333333"));
        body.setPadding(0, 24, 0, 0);
        box.addView(body);

        return box;
    }
}
