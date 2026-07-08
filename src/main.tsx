import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Follow the OS theme, live. Toggles `.dark` (shadcn/Fluid convention) and the
// native color-scheme so form controls / scrollbars match.
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (dark: boolean) => {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
};
applyTheme(mq.matches);
mq.addEventListener("change", (e) => applyTheme(e.matches));

// No StrictMode: it double-invokes effects, which would spawn/kill the stateful
// Pi subprocess twice on mount and interrupt in-flight turns.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
