import React from "react";

interface PixelClockProps {
  value: string;
  dotSize?: number;
  gap?: number;
  className?: string;
}

const GLYPHS: Record<string, string[]> = {
  "0": [
    "00111100",
    "01100110",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "11000011",
    "01100110",
    "00111100",
  ],
  "1": [
    "00011000",
    "00111000",
    "01111000",
    "00011000",
    "00011000",
    "00011000",
    "00011000",
    "00011000",
    "00111100",
    "00111100",
  ],
  "2": [
    "00111100",
    "01100110",
    "11000011",
    "00000011",
    "00000110",
    "00001100",
    "00110000",
    "01100000",
    "11111111",
    "11111111",
  ],
  "3": [
    "00111100",
    "01100110",
    "11000011",
    "00000011",
    "00011110",
    "00011110",
    "00000011",
    "11000011",
    "01100110",
    "00111100",
  ],
  "4": [
    "00000110",
    "00001110",
    "00011110",
    "00110110",
    "01100110",
    "11000110",
    "11111111",
    "11111111",
    "00000110",
    "00000110",
  ],
  "5": [
    "11111111",
    "11111111",
    "11000000",
    "11111100",
    "11111110",
    "00000011",
    "00000011",
    "11000011",
    "01100110",
    "00111100",
  ],
  "6": [
    "00111100",
    "01100110",
    "11000011",
    "11000000",
    "11111100",
    "11111110",
    "11000011",
    "11000011",
    "01100110",
    "00111100",
  ],
  "7": [
    "11111111",
    "11111111",
    "00000110",
    "00001100",
    "00011000",
    "00110000",
    "00110000",
    "00110000",
    "00110000",
    "00110000",
  ],
  "8": [
    "00111100",
    "01100110",
    "11000011",
    "01100110",
    "00111100",
    "01100110",
    "11000011",
    "11000011",
    "01100110",
    "00111100",
  ],
  "9": [
    "00111100",
    "01100110",
    "11000011",
    "11000011",
    "01111111",
    "00111111",
    "00000011",
    "11000011",
    "01100110",
    "00111100",
  ],
  ":": [
    "00",
    "00",
    "11",
    "11",
    "00",
    "00",
    "11",
    "11",
    "00",
    "00",
  ],
};

function PixelGlyph({
  char,
  dotSize,
  gap,
}: {
  char: string;
  dotSize: number;
  gap: number;
}) {
  const rows = GLYPHS[char] ?? GLYPHS["0"];
  const cols = rows[0]?.length ?? 8;

  return (
    <div
      aria-hidden="true"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, ${dotSize}px)`,
        gridTemplateRows: `repeat(${rows.length}, ${dotSize}px)`,
        gap,
      }}
    >
      {rows.flatMap((row, rowIndex) =>
        row.split("").map((bit, colIndex) => (
          <span
            key={`${char}-${rowIndex}-${colIndex}`}
            className={`pixel-clock-dot ${bit === "1" ? "pixel-clock-dot-on" : "pixel-clock-dot-off"}`}
            style={{
              width: dotSize,
              height: dotSize,
            }}
          />
        )),
      )}
    </div>
  );
}

export function PixelClock({
  value,
  dotSize = 10,
  gap = 4,
  className,
}: PixelClockProps) {
  return (
    <div
      aria-label={value}
      className={`pixel-clock ${className ?? ""}`.trim()}
      style={{ display: "flex", alignItems: "center", gap: dotSize }}
    >
      {value.split("").map((char, index) => (
        <PixelGlyph key={`${char}-${index}`} char={char} dotSize={dotSize} gap={gap} />
      ))}
    </div>
  );
}
