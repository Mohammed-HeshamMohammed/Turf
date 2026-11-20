import { useEffect, useState, type AnchorHTMLAttributes } from "react";

/** The page the visitor is on. `initial` is the path the page was first rendered for (the server has no location). */
export function useRoute(initial: string) {
  const [path, setPath] = useState(initial);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  return path;
}

export const go = (to: string, { replace = false }: { replace?: boolean } = {}) => {
  history[replace ? "replaceState" : "pushState"](null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
  if (!replace) scrollTo(0, 0);
};

export function Link({ to, children, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      onClick={e => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button || e.currentTarget.target === "_blank") return;
        e.preventDefault();
        go(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
