import { View } from "react-native";
import { WebView } from "react-native-webview";

import { artifactHtmlFrameDocument, artifactHtmlLoadAllowed } from "./artifactHtmlPreview.logic";

/**
 * An HTML artifact in web's frame with nothing enabled (`sandbox=""`): no scripts, forms, popups,
 * downloads or escape to the top; links still navigate inside the frame and images and styles
 * still load, as on web. Its height is fixed, as web's is, and it scrolls inside.
 */
export function ArtifactHtmlPreview(props: {
  readonly html: string;
  readonly path: string;
  readonly height: number;
}) {
  return (
    <View
      accessibilityLabel={`Artifact preview: ${props.path}`}
      className="overflow-hidden rounded-2xl border border-border"
      style={{ height: props.height }}
    >
      <WebView
        source={{ html: artifactHtmlFrameDocument(props.html) }}
        // Every origin passes this list, so nothing is handed to the system browser. The check
        // below holds the top on the page as a second line; the frame's sandbox is the boundary,
        // since Android skips the check for form posts.
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={artifactHtmlLoadAllowed}
        javaScriptEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        geolocationEnabled={false}
        allowsLinkPreview={false}
        mediaPlaybackRequiresUserAction
        mixedContentMode="never"
        nestedScrollEnabled
        style={{ flex: 1, backgroundColor: "#fff" }}
      />
    </View>
  );
}
