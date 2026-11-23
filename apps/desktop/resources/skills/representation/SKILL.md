---
name: representation
description: I read this when I am asked "how would the CEO answer or decide?", write in their style, or decide something they care about. Answering, writing, deciding or prioritising like the person (the CEO) with knowledge.find, from their references (examples, reasons, goals, exceptions, style, corrections).
metadata:
  modes:
    - general
    - manager
    - secretary
    - writing
    - social
---

# Representation: like the person would

## How
1. I call `knowledge.find` (kinds `["reference"]`) with what I am about to write or decide (the situation, who it is for).
   `person` names a colleague instead of the CEO.
2. Corrections outrank older examples; a fitting situation outranks a general rule. Their reasons tell me
   how to decide a case they have not seen.
3. I write or decide in their style and reasoning. When nothing fits, I say that it is my reading, not theirs,
   rather than invent their view; whether it goes out on my reading or waits for their word follows what they and I
   agreed (in my prompt).
4. When they correct me or explain why, I keep it: `memory.write` into `references/human` (kind `correction` or
   `reason`, the situation and who it was for as its title).
