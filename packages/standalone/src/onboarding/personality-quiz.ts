/**
 * Personality Quiz for Bootstrap Ritual
 *
 * Helps users discover what kind of AI assistant they want through
 * fun, scenario-based questions instead of direct personality selection.
 */

export interface PersonalityType {
  id: string;
  name: string;
  emoji: string;
  description: string;
  traits: string[];
  voiceSample: string;
}

export interface QuizQuestion {
  id: string;
  question: string;
  scenario: string;
  choices: QuizChoice[];
}

export interface QuizChoice {
  id: string;
  text: string;
  scores: Record<string, number>;
}

export interface QuizResult {
  topPersonality: PersonalityType;
  scores: Record<string, number>;
  allPersonalities: PersonalityType[];
}

export const PERSONALITY_TYPES: PersonalityType[] = [
  {
    id: 'wise_mentor',
    name: 'Wise Mentor',
    emoji: '🧙',
    description: 'Calm, thorough, educational. Explains the "why" behind everything.',
    traits: ['Patient', 'Thorough', 'Educational', 'Thoughtful'],
    voiceSample:
      "\"Interesting question. Let's explore the root cause together. Here's what's happening under the hood...\"",
  },
  {
    id: 'energetic_partner',
    name: 'Energetic Partner',
    emoji: '⚡',
    description: 'Enthusiastic, collaborative, creative. Builds things together with you.',
    traits: ['Enthusiastic', 'Collaborative', 'Creative', 'Supportive'],
    voiceSample: '"OH! I have an idea! What if we tried...? This is going to be awesome!!"',
  },
  {
    id: 'pragmatic_assistant',
    name: 'Pragmatic Assistant',
    emoji: '🤖',
    description: 'Efficient, direct, no-nonsense. Gets things done quickly.',
    traits: ['Efficient', 'Direct', 'Reliable', 'Focused'],
    voiceSample:
      '"Here\'s the solution. Three steps: 1. Fix the config. 2. Restart. 3. Test. Done."',
  },
  {
    id: 'creative_rebel',
    name: 'Creative Rebel',
    emoji: '✨',
    description: 'Innovative, experimental, challenges conventions. Loves wild ideas.',
    traits: ['Innovative', 'Bold', 'Experimental', 'Unconventional'],
    voiceSample:
      '"Wait... what if we completely rethink this? Forget best practices for a sec—what if we just...?"',
  },
  {
    id: 'analytical_thinker',
    name: 'Analytical Thinker',
    emoji: '📊',
    description: 'Logical, data-driven, systematic. Analyzes everything deeply.',
    traits: ['Logical', 'Systematic', 'Data-driven', 'Precise'],
    voiceSample:
      '"Let\'s look at the data. Based on metrics, approach A has 73% success rate vs B at 58%. Clear choice."',
  },
];

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 'q1',
    question: "It's 2AM and you're stuck on a nasty bug. How should I help?",
    scenario: '🐛 Debugging Crisis',
    choices: [
      {
        id: 'a',
        text: '🔬 Debug methodically, explain every step',
        scores: { wise_mentor: 3, analytical_thinker: 2 },
      },
      {
        id: 'b',
        text: '☕ Keep you company, brainstorm wild fixes together',
        scores: { energetic_partner: 3, creative_rebel: 2 },
      },
      {
        id: 'c',
        text: '🎯 Just give the fix ASAP so you can sleep',
        scores: { pragmatic_assistant: 3 },
      },
      {
        id: 'd',
        text: '🧠 Question assumptions, try experimental approaches',
        scores: { creative_rebel: 3, analytical_thinker: 1 },
      },
    ],
  },
  {
    id: 'q2',
    question: "You're starting a new project. What's my role?",
    scenario: '🚀 New Project',
    choices: [
      {
        id: 'a',
        text: '📚 Guide you through best practices and patterns',
        scores: { wise_mentor: 3, analytical_thinker: 1 },
      },
      {
        id: 'b',
        text: '🎨 Get excited! Explore crazy possibilities together',
        scores: { energetic_partner: 3, creative_rebel: 2 },
      },
      {
        id: 'c',
        text: '⚙️ Set up the structure efficiently, no fluff',
        scores: { pragmatic_assistant: 3 },
      },
      {
        id: 'd',
        text: '💡 Challenge conventions, suggest innovative approaches',
        scores: { creative_rebel: 3, energetic_partner: 1 },
      },
    ],
  },
  {
    id: 'q3',
    question: 'We disagree on how to solve a problem. I should...',
    scenario: '💬 Conflict Resolution',
    choices: [
      {
        id: 'a',
        text: '⚖️ Present pros/cons systematically with data',
        scores: { analytical_thinker: 3, wise_mentor: 2 },
      },
      {
        id: 'b',
        text: '🤝 Find a creative compromise that satisfies both',
        scores: { creative_rebel: 2, energetic_partner: 2 },
      },
      {
        id: 'c',
        text: '👍 Defer to your judgment, you know best',
        scores: { pragmatic_assistant: 3 },
      },
      {
        id: 'd',
        text: '🔥 Push back with solid reasoning, debate it out',
        scores: { wise_mentor: 2, analytical_thinker: 2 },
      },
    ],
  },
];

export function calculateQuizResult(answers: Record<string, string>): QuizResult {
  const scores: Record<string, number> = {
    wise_mentor: 0,
    energetic_partner: 0,
    pragmatic_assistant: 0,
    creative_rebel: 0,
    analytical_thinker: 0,
  };

  for (const question of QUIZ_QUESTIONS) {
    const answerId = answers[question.id];
    if (!answerId) continue;

    const choice = question.choices.find((c) => c.id === answerId);
    if (!choice) continue;

    for (const [personalityId, points] of Object.entries(choice.scores)) {
      scores[personalityId] += points;
    }
  }

  const topPersonalityId = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  const topPersonality = PERSONALITY_TYPES.find((p) => p.id === topPersonalityId)!;

  return {
    topPersonality,
    scores,
    allPersonalities: PERSONALITY_TYPES,
  };
}

export function formatQuizResultMessage(result: QuizResult, language: 'en' | 'ko'): string {
  const { topPersonality, scores } = result;

  if (language === 'ko') {
    const sortedScores = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => {
        const p = PERSONALITY_TYPES.find((pt) => pt.id === id)!;
        return `${p.emoji} ${p.name}: ${score} pts`;
      })
      .join('\n');

    return `## 🎯 Quiz Results!

Based on your answers:

${sortedScores}

**Recommended Personality: ${topPersonality.emoji} ${topPersonality.name}**

${topPersonality.description}

**Key Traits:**
${topPersonality.traits.map((t) => `• ${t}`).join('\n')}

**Voice Sample:**
> ${topPersonality.voiceSample}

Does this feel right? Or would you prefer a different style?`;
  } else {
    const sortedScores = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => {
        const p = PERSONALITY_TYPES.find((pt) => pt.id === id)!;
        return `${p.emoji} ${p.name}: ${score} pts`;
      })
      .join('\n');

    return `## 🎯 Quiz Results!

Based on your answers:

${sortedScores}

**Recommended Personality: ${topPersonality.emoji} ${topPersonality.name}**

${topPersonality.description}

**Key Traits:**
${topPersonality.traits.map((t) => `• ${t}`).join('\n')}

**Voice Sample:**
> ${topPersonality.voiceSample}

Does this feel right? Or would you prefer a different style?`;
  }
}
