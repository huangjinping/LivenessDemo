# Liveness Detection Demo (Web & Android WebView)

This is a web-based liveness detection demo using `face-api.js` (TensorFlow.js). It detects:
1.  **Blink** (眨眼)
2.  **Open Mouth** (张嘴)
3.  **Shake Head** (摇头)

## Project Setup

### Prerequisites
- Node.js (v14+)
- npm

### Installation
1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Run development server:
    ```bash
    npm run dev
    ```
3.  Build for production:
    ```bash
    npm run build
    ```
    The output will be in the `dist` folder.

## Android WebView Integration Guide

To run this in an Android WebView, you must configure the WebView to allow camera access and JavaScript.

### Key Requirements
1.  **Permissions**: Ensure your Android app has camera permissions in `AndroidManifest.xml`.
    ```xml
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.INTERNET" />
    ```

2.  **WebView Configuration**:
    ```java
    WebView webView = findViewById(R.id.webview);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false); // Important for autoplay
    
    // Grant permissions (Camera)
    webView.setWebChromeClient(new WebChromeClient() {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            // Check if the request is for camera
             if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                request.grant(request.getResources());
            }
        }
    });
    ```

3.  **HTTPS**: `getUserMedia` (camera access) **requires a Secure Context** (HTTPS or localhost).
    - If loading from a remote server, it MUST be HTTPS.
    - If loading local HTML files (file:///), Chrome usually blocks camera access due to security policies. It is recommended to run a local web server inside the Android app (e.g., using `NanoHTTPD` or similar) or host the web app on a secure server.
    - Alternatively, for testing, you can bypass this, but it's tricky on modern Android WebViews. The standard way is hosting on HTTPS.

## How it works
1.  **Blink**: Calculates Eye Aspect Ratio (EAR). Detects eyes closing and opening.
2.  **Mouth**: Calculates Mouth Aspect Ratio (MAR). Detects mouth opening wide.
3.  **Shake**: Tracks the horizontal position of the nose relative to the face boundaries. Detects movement to the left and right within 2 seconds.
