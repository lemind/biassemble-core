{
  "type": "object",
  "properties": {
    "biases": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "description": "Name of the cognitive bias" },
          "explanation": { "type": "string", "description": "Why this bias might be relevant" },
          "storyConnection": { "type": "string", "description": "Specific reference to the user's story or answers" },
          "alternativePerspective": { "type": "string", "description": "A different way to interpret the situation" }
        },
        "required": ["name", "explanation", "storyConnection", "alternativePerspective"]
      },
      "minItems": 1,
      "description": "Detected cognitive biases with narrative fields"
    },
    "reflectionPrompt": {
      "type": "string",
      "description": "A closing reflection prompt to help the user think deeper"
    }
  },
  "required": ["biases", "reflectionPrompt"]
}
