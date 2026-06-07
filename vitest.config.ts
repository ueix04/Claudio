import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "backend",
          globals: true,
          environment: "node",
          include: ["backend/src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "frontend",
          globals: true,
          environment: "node",
          include: ["frontend/src/**/*.test.ts", "frontend/src/**/*.test.tsx"],
        },
      },
    ],
  },
});