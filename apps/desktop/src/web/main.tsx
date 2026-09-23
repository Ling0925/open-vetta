import { createRoot } from "react-dom/client";
import { WebApp } from "./App.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing Web root element");

createRoot(rootElement).render(<WebApp />);
