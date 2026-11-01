import { RegistryContext } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Atom } from "effect/reactivity";

/** Fabric never freezes the route below focus; Home must stop its own work beneath Thread. */
export function useHomeRouteVisible(): boolean {
  const navigation =
    useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList, "Home">>();
  // A cold deep link mounts Home under its Thread without ever showing it.
  const [visible, setVisible] = useState(() => {
    console.log("HOME842 mount focused=", navigation.isFocused());
    return navigation.isFocused();
  });
  console.log("HOME842 render visible=", visible, "focused=", navigation.isFocused());
  useEffect(() => {
    const show = () => setVisible(true);
    const removeTransitionStart = navigation.addListener("transitionStart", ({ data }) => {
      console.log("HOME842 transitionStart closing=", data.closing);
      if (!data.closing) show();
    });
    const removeTransitionEnd = navigation.addListener("transitionEnd", ({ data }) => {
      console.log("HOME842 transitionEnd closing=", data.closing);
      if (data.closing) setVisible(false);
    });
    // Popping a sheet or a deep-linked route above Home has no appear event.
    const removeFocus = navigation.addListener("focus", () => {
      console.log("HOME842 focus");
      show();
    });
    const removeBlur = navigation.addListener("blur", () => console.log("HOME842 blur"));
    return () => {
      removeBlur();
      removeTransitionStart();
      removeTransitionEnd();
      removeFocus();
    };
  }, [navigation]);
  return visible;
}

export function useAtomValueWhileVisible<A>(atom: Atom.Atom<A>, visible: boolean): A {
  const registry = useContext(RegistryContext);
  const held = useRef<{ readonly value: A } | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => (visible ? registry.subscribe(atom, onChange) : () => undefined),
    [registry, atom, visible],
  );
  return useSyncExternalStore(subscribe, () => {
    if (visible || held.current === null) held.current = { value: registry.get(atom) };
    return held.current.value;
  });
}
