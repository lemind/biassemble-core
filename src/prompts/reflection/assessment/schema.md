{
  "type": "object",
  "properties": {
    "reasoning_trace": {
      "type": "object",
      "description": "Structured reasoning steps leading to the assessment",
      "properties": {
        "story_analysis": {
          "type": "object",
          "properties": {
            "themes": {
              "type": "array",
              "items": { "type": "string" },
              "description": "Core themes identified from the user's story and answers"
            },
            "emotional_tone": {
              "type": "string",
              "description": "The emotional state or tone of the user's narrative"
            },
            "key_events": {
              "type": "array",
              "items": { "type": "string" },
              "description": "Significant events or turning points in the story"
            }
          },
          "required": ["themes", "emotional_tone", "key_events"]
        },
        "interpretations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "interpretation": { "type": "string", "description": "A plausible interpretation of the situation" },
              "plausibility": { "type": "number", "minimum": 0, "maximum": 1, "description": "Plausibility score (0.0–1.0)" },
              "supporting_evidence": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Quotes or references from the story/answers supporting this interpretation"
              }
            },
            "required": ["interpretation", "plausibility", "supporting_evidence"]
          },
          "minItems": 1,
          "description": "Ranked interpretations from most to least plausible"
        },
        "bias_hypotheses": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "bias_name": { "type": "string", "description": "Name of the bias from the provided catalog" },
              "confidence": { "type": "number", "minimum": 0, "maximum": 1, "description": "Confidence score (0.0–1.0)" },
              "supporting_excerpts": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Verbatim excerpts from the story/answers supporting this hypothesis"
              },
              "uncertainty_reasons": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Reasons for uncertainty when meaningful uncertainty exists"
              }
            },
            "required": ["bias_name", "confidence", "supporting_excerpts"]
          },
          "minItems": 1,
          "description": "Cognitive bias hypotheses for the most plausible interpretations"
        },
        "evidence_mapping": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "bias_id": { "type": "string", "description": "The bias name from the catalog (matches bias_hypotheses.bias_name)" },
              "evidence": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "source": { "type": "string", "enum": ["story", "answer"], "description": "Whether the excerpt comes from the original story or a follow-up answer" },
                    "excerpt": { "type": "string", "description": "Verbatim excerpt from the input" },
                    "relevance": { "type": "string", "description": "Why this excerpt is relevant to the bias" }
                  },
                  "required": ["source", "excerpt", "relevance"]
                },
                "minItems": 1
              }
            },
            "required": ["bias_id", "evidence"]
          },
          "minItems": 1,
          "description": "Master set of evidence entries for each bias hypothesis"
        }
      },
      "required": ["story_analysis", "interpretations", "bias_hypotheses", "evidence_mapping"]
    },
    "biases": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "description": "Name of the cognitive bias from the catalog" },
          "explanation": { "type": "string", "description": "Why this bias might be relevant" },
          "storyConnection": { "type": "string", "description": "Specific reference to the user's story or answers" },
          "alternativePerspective": { "type": "string", "description": "A different way to interpret the situation" },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source": { "type": "string", "enum": ["story", "answer"], "description": "Whether the excerpt comes from the original story or a follow-up answer" },
                "excerpt": { "type": "string", "description": "Verbatim excerpt from the input, drawn from evidence_mapping" },
                "relevance": { "type": "string", "description": "Why this excerpt is relevant to the bias" }
              },
              "required": ["source", "excerpt", "relevance"]
            },
            "minItems": 1,
            "description": "Supporting evidence for this bias, drawn from evidence_mapping"
          }
        },
        "required": ["name", "explanation", "storyConnection", "alternativePerspective", "evidence"]
      },
      "description": "Detected cognitive biases with narrative fields and evidence binding"
    },
    "reflectionPrompt": {
      "type": "string",
      "description": "A closing reflection prompt to help the user think deeper"
    },
    "no_bias_detected": {
      "type": "boolean",
      "description": "When true, no cognitive biases were found and biases array may be empty"
    }
  },
  "required": ["reasoning_trace", "biases", "reflectionPrompt", "no_bias_detected"]
}