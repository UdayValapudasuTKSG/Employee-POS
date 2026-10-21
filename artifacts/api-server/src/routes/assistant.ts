import { Router, type IRouter } from "express";
import { AskAssistantBody } from "@workspace/api-zod";

const router: IRouter = Router();

const HR_FALLBACK =
  "I'm not sure about that one. For anything account-specific — or if you're still stuck — please contact your company's HR department. They can help with your registered details and coverage questions.";

interface FaqTopic {
  keywords: string[];
  answer: string;
}

// Curated knowledge base: general portal guidance only.
// The assistant never looks up or reveals member data.
const FAQ_TOPICS: FaqTopic[] = [
  {
    keywords: [
      "find",
      "get",
      "card",
      "digital",
      "access",
      "view",
      "retrieve",
      "lookup",
      "look",
    ],
    answer:
      'To get your digital health card, click "Find my card" on this page, enter the email or phone number registered with your employer, and then enter the one-time verification code we send you. Your card appears right away once the code is verified.',
  },
  {
    keywords: [
      "code",
      "otp",
      "verification",
      "arrive",
      "arrived",
      "arriving",
      "receive",
      "received",
      "didn't",
      "didnt",
      "not",
      "never",
      "resend",
      "expired",
      "waiting",
    ],
    answer:
      "If your verification code hasn't arrived, first check your spam or junk folder (for email) or your messages (for SMS). Codes expire after a few minutes, so you can request a new one from the verification screen. If codes still don't arrive, your registered contact details may be out of date — contact your HR department to confirm them.",
  },
  {
    keywords: [
      "email",
      "phone",
      "number",
      "contact",
      "changed",
      "change",
      "update",
      "updated",
      "new",
      "moved",
      "wrong",
      "details",
      "address",
    ],
    answer:
      "Contact detail changes (email or phone number) are managed by your employer. Please reach out to your company's HR department — they can update your registered contact information so codes reach you at the right place.",
  },
  {
    keywords: [
      "dependent",
      "dependents",
      "spouse",
      "child",
      "children",
      "family",
      "wife",
      "husband",
      "kids",
    ],
    answer:
      "Your digital card shows all covered dependents on your policy. To add, remove, or correct a dependent, contact your HR department — they manage enrollment changes with the insurer.",
  },
  {
    keywords: [
      "coverage",
      "covered",
      "policy",
      "plan",
      "benefits",
      "claim",
      "claims",
      "eligible",
      "eligibility",
    ],
    answer:
      "Your card shows your policy details and covered dependents. Note that the card is for identification only and doesn't guarantee eligibility. For specific coverage, benefits, or claims questions, contact your HR department or your insurer directly.",
  },
  {
    keywords: [
      "lost",
      "stolen",
      "physical",
      "print",
      "printed",
      "paper",
      "replace",
      "replacement",
    ],
    answer:
      "If your physical card is lost or stolen, report it to your HR department immediately. In the meantime, you can always retrieve your digital card here — it shows the same policy information.",
  },
  {
    keywords: [
      "visible",
      "expire",
      "expires",
      "long",
      "session",
      "minutes",
      "time",
    ],
    answer:
      "For your security, your card stays visible for a limited time after you verify. You can always retrieve it again with a new code — just start the lookup again.",
  },
  {
    keywords: ["locked", "lock", "attempts", "attempt", "incorrect", "tries"],
    answer:
      "After several incorrect codes the session locks for a few minutes. Wait a moment, then start the lookup again to get a fresh code.",
  },
  {
    keywords: [
      "secure",
      "security",
      "safe",
      "privacy",
      "private",
      "data",
      "share",
      "shared",
    ],
    answer:
      "The portal uses one-time verification codes sent only to the email or phone number registered with your employer, so only you can access your card. Your information is never shared through this chat, and card access links expire automatically.",
  },
  {
    keywords: ["hr", "human", "resources", "who", "help", "support", "talk", "someone"],
    answer:
      "For account-specific help — like updating your contact details, dependents, or coverage — your company's HR department is the right contact. For trouble using this portal, try the steps on this page first, then reach out to HR if you're still stuck.",
  },
];

const STOP_WORDS = new Set([
  "i",
  "a",
  "an",
  "the",
  "my",
  "me",
  "is",
  "it",
  "to",
  "do",
  "how",
  "can",
  "what",
  "and",
  "or",
  "of",
  "in",
  "on",
  "for",
  "you",
  "your",
  "please",
  "hi",
  "hello",
]);

export function answerQuestion(message: string): { reply: string; matched: boolean } {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  let best: FaqTopic | null = null;
  let bestScore = 0;

  for (const topic of FAQ_TOPICS) {
    let score = 0;
    for (const word of words) {
      if (topic.keywords.includes(word)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }

  // Require at least one meaningful keyword hit; otherwise defer to HR.
  if (best && bestScore >= 1) {
    return { reply: best.answer, matched: true };
  }
  return { reply: HR_FALLBACK, matched: false };
}

router.post("/v1/assistant/ask", (req, res) => {
  const parsed = AskAssistantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "INVALID_INPUT", message: "Please enter a question (up to 500 characters)." },
    });
    return;
  }
  res.json(answerQuestion(parsed.data.message));
});

export default router;
