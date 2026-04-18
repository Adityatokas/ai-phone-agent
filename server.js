import express from "express";
import twilio from "twilio";
import { urlencoded } from "express";

const app = express();
app.use(urlencoded({ extended: false }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

// Store conversation history per call
const callSessions = new Map();

const SYSTEM_PROMPT = `You are a friendly and helpful AI voice assistant answering phone calls.
Keep all responses short and natural for voice — 1 to 3 sentences max.
Never use bullet points, markdown, lists, or special characters.
Speak conversationally as if talking on the phone.
If someone asks who you are, say you are an AI assistant.
If someone wants to leave a message, take their name and message and confirm it back to them.`;

// Call Groq API
async function askGroq(messages) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama3-8b-8192",
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
      ],
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "I am sorry, I could not get a response.";
}

// Health check
app.get("/", (req, res) => {
  res.send("AI Voice Agent (Groq) is running!");
});

// Twilio calls this when someone calls your number
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid;
  callSessions.set(callSid, []);

  const twiml = new VoiceResponse();

  twiml.say(
    { voice: "Polly.Joanna", language: "en-US" },
    "Hello! I am your AI assistant. How can I help you today?"
  );

  twiml.gather({
    input: "speech",
    action: "/respond",
    method: "POST",
    speechTimeout: "auto",
    language: "en-US",
  });

  twiml.say(
    { voice: "Polly.Joanna" },
    "I did not hear anything. Please call again and speak after the greeting. Goodbye!"
  );
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// Twilio calls this after each thing the caller says
app.post("/respond", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  const confidence = parseFloat(req.body.Confidence || "0");

  const twiml = new VoiceResponse();

  // If speech was unclear
  if (!speechResult || confidence < 0.3) {
    twiml.say(
      { voice: "Polly.Joanna" },
      "Sorry, I did not catch that. Could you please repeat?"
    );
    twiml.gather({
      input: "speech",
      action: "/respond",
      method: "POST",
      speechTimeout: "auto",
      language: "en-US",
    });
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Get session history
  if (!callSessions.has(callSid)) callSessions.set(callSid, []);
  const history = callSessions.get(callSid);
  history.push({ role: "user", content: speechResult });

  try {
    const reply = await askGroq(history);

    // Save assistant reply to history
    history.push({ role: "assistant", content: reply });
    callSessions.set(callSid, history);

    // Check if caller wants to end the call
    const endPhrases = [
      "goodbye", "bye", "hang up", "end call",
      "that's all", "thanks bye", "thank you bye", "see you",
    ];
    const wantsToEnd = endPhrases.some((p) =>
      speechResult.toLowerCase().includes(p)
    );

    twiml.say({ voice: "Polly.Joanna", language: "en-US" }, reply);

    if (wantsToEnd) {
      twiml.say({ voice: "Polly.Joanna" }, "Goodbye! Have a great day!");
      twiml.hangup();
      callSessions.delete(callSid);
    } else {
      twiml.gather({
        input: "speech",
        action: "/respond",
        method: "POST",
        speechTimeout: "auto",
        language: "en-US",
      });

      twiml.say(
        { voice: "Polly.Joanna" },
        "Are you still there? Feel free to ask me anything."
      );
      twiml.gather({
        input: "speech",
        action: "/respond",
        method: "POST",
        speechTimeout: "auto",
        language: "en-US",
      });

      twiml.say({ voice: "Polly.Joanna" }, "I did not hear anything. Goodbye!");
      twiml.hangup();
      callSessions.delete(callSid);
    }
  } catch (err) {
    console.error("Groq API error:", err);
    twiml.say(
      { voice: "Polly.Joanna" },
      "I am sorry, something went wrong. Please try calling again."
    );
    twiml.hangup();
    callSessions.delete(callSid);
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Voice Agent (Groq) running on port ${PORT}`);
});
