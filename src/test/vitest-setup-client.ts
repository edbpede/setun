/**
 * Setup for the Vitest Browser Mode project.
 *
 * Component tests mount a component directly, without the root layout, so the
 * stylesheets the layout imports are absent unless loaded here. Without them
 * every themed assertion silently passes against unstyled markup — a colour
 * utility whose variable does not resolve degrades to transparent rather than
 * failing loudly.
 */
import "virtual:uno.css";
import "../app.css";
