import { View } from "./view";

// Client-side session; nothing to prerender for instant navigation.
export const instant = false;

export default function Page() {
  return <View />;
}
