{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 2,
      "maxItems": 5,
      "description": "Contextual follow-up questions for the user's story"
    },
    "isComplete": {
      "type": "boolean",
      "description": "Indicates whether the question batch is complete"
    }
  },
  "required": ["questions", "isComplete"]
}
