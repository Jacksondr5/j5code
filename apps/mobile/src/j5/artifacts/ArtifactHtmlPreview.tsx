import { useWindowDimensions, View } from "react-native";
import { WebView } from "react-native-webview";

import { artifactHtmlLoadAllowed } from "./artifactHtmlPreview.logic";

/**
 * An HTML artifact rendered as web shows it, in a frame with nothing enabled (`sandbox=""`): no
 * scripts, storage, cookies, file access or new windows, and no navigation. Images and styles it
 * links still load, as in web's frame. Its height is fixed, as web's is, and it scrolls inside.
 */
export function ArtifactHtmlPreview(props: { readonly html: string; readonly path: string }) {
  const { height } = useWindowDimensions();
  return (
    <View
      accessibilityLabel={`Artifact preview: ${props.path}`}
      className="overflow-hidden rounded-xl border border-border"
      style={{ height: Math.max(384, height - 160) }}
    >
      <WebView
        source={{ html: props.html }}
        // Every origin passes this list, so nothing is handed to the system browser; the check
        // below then refuses every load but the artifact's own.
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(request) => artifactHtmlLoadAllowed(request.url)}
        javaScriptEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        incognito
        geolocationEnabled={false}
        allowsLinkPreview={false}
        mediaPlaybackRequiresUserAction
        mixedContentMode="never"
        nestedScrollEnabled
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
