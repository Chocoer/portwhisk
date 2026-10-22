import raycast from "@raycast/eslint-config";

export default [
  ...raycast,
  {
    files: ["assets/system.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ObjC: "readonly", $: "readonly", Ref: "readonly" },
    },
  },
];
