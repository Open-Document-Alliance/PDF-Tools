// Shared listing metadata for the portable manifest and Codex compatibility
// manifest. These describe the local product, not the smaller hosted connector.
export function createOpenAIPluginMetadata() {
  return {
    interface: {
      displayName: "PDF Tools",
      shortDescription: "Read, edit and sign PDFs",
      longDescription:
        "Work with PDFs on your own machine. Read text and layout with real coordinates, convert to Markdown with evidence-backed tables, fill and validate forms, merge, split and reorder pages, compare documents, and inspect accessibility signals. The PDF workspace provides an interactive viewer and local editing tools. Verified extraction preserves progress and source citations while explicitly reporting missing or unsupported information. Local signature stamps are not cryptographic signatures. Optional Lumin signing requires a configured connection and your confirmation before the PDF and recipient details are sent to Lumin. PDF Tools uses a private import workspace by default; direct folder access is optional. Your host's permissions govern which files it may import, and content returned to the host follows its data terms.",
      developerName: "Open Document Alliance",
      category: "Productivity",
      capabilities: ["Document workflows", "Forms", "Extraction", "Safety checks"],
      websiteURL: "https://github.com/Open-Document-Alliance/pdf-tools-plugin",
      supportURL: "https://github.com/Open-Document-Alliance/PDF-Tools/issues",
      privacyPolicyURL: "https://www.opendocuments.ai/privacy-policy",
      termsOfServiceURL: "https://www.opendocuments.ai/terms-of-service",
      logo: "./assets/pdf-tools.png",
      composerIcon: "./assets/pdf-tools.png",
      defaultPrompt: [
        "Read this PDF and tell me what is in it.",
        "Fill this form from my saved profile, then read the fields back.",
        "Compare these two PDFs and state every coverage gap.",
      ],
    },
  };
}
