// Owns: same-origin browsing, external links, the address autark-app:forget ("Forget this phone"; the app takes it over),
// telling the activity when a new document of its own origin is ready (NativePort hands it the port then), the app's
// "can't reach" screen when the PC's UI does not load, and recovery when the WebView's renderer crashed or was killed
// (the activity makes a new WebView instead of the app dying). Never: bypasses TLS errors.
package com.teydralab.autark.android;

import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

final class PhoneNavigation extends WebViewClient {
    /** What the activity does for the WebView (MainActivity implements it). */
    interface Host {
        void confirmForget();
        boolean sameOrigin(String url);
        void openExternal(Uri uri);
        /** A main-frame page of the app's origin finished; newDocument is false for an in-page route change. */
        void pageReady(WebView view, String url, boolean newDocument);
        void offline(String reason);
        /** The renderer is gone: drop this WebView and open a new one on the same place. */
        void rendererGone(WebView view);
    }

    static final String FORGET = "autark-app:forget";
    private final Host host;
    private boolean newDocument;

    PhoneNavigation(Host host) { this.host = host; }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) return false;
        String url = request.getUrl().toString();
        if (FORGET.equals(url)) { host.confirmForget(); return true; }
        if (host.sameOrigin(url)) return false;
        host.openExternal(request.getUrl());
        return true;
    }

    @Override public void onPageStarted(WebView view, String url, Bitmap favicon) { newDocument = true; }

    @Override public void onPageFinished(WebView view, String url) {
        if (!host.sameOrigin(url)) return;
        android.webkit.CookieManager.getInstance().flush();
        boolean fresh = newDocument;
        newDocument = false;
        host.pageReady(view, url, fresh);
    }

    @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame() || !host.sameOrigin(request.getUrl().toString())) return;
        host.offline("No PC answered. Autark has to be running on at least one of your PCs, and this phone needs internet.");
    }

    @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (!request.isForMainFrame() || !host.sameOrigin(request.getUrl().toString())) return;
        host.offline(response.getStatusCode() == 503 ? "None of your PCs is reachable right now. Autark has to be running on at least one of them." : "The PC answered HTTP " + response.getStatusCode() + ".");
    }

    @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();
        host.offline("A certificate is not valid. The page was not loaded.");
    }

    @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        host.rendererGone(view);
        return true; // the app lives on; the activity has dropped this WebView
    }
}
