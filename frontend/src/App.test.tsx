import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App audio elements", () => {
  it("renders current music, preloaded next music, and TTS audio elements", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup.match(/<audio/g)?.length).toBe(3);
    expect(markup.match(/preload="auto"/g)?.length).toBe(3);
  });
});
