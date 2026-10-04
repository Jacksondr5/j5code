import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * Fork-owned mark used where the upstream client renders its compact T3 wordmark.
 * Same path as the web `J5Wordmark`; width derives from the viewBox aspect ratio.
 */
export function J5Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 94 / 57;
  return (
    <Svg
      accessibilityLabel="J5"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 94 57"
    >
      <ThemedPath
        d="M0 0H44V34C44 48.5 36 57 22 57C8.8 57 1 49.5 0 36H13C14 42.2 17.2 45.5 23 45.5C28.6 45.5 31 41.5 31 34V11H13V0H0ZM51 0H91V11H63L62 21C66.2 19 70.7 18 76 18C87.2 18 94 25.2 94 36.5C94 49.3 84.2 57 70 57C60.7 57 52.8 54.3 47 49L53 39C58.1 43.3 64 46 70 46C77 46 81 42.4 81 37C81 31.3 77.2 28 70 28C65 28 60.8 29 56 31L50 27L51 0Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
