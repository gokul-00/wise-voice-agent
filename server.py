import os
import json
import httpx
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, Response
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# Load FAQ knowledge base
script_dir = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(script_dir, "faq_knowledge.json"), "r", encoding="utf-8") as f:
    FAQ_KNOWLEDGE = json.load(f)

# Build FAQ context string for the system prompt
FAQ_CONTEXT = "\n\n".join(
    f"FAQ {i+1}: {faq['question']}\n{faq['answer']}"
    for i, faq in enumerate(FAQ_KNOWLEDGE)
)

SYSTEM_PROMPT = f"""You are Gokul, a patient and knowledgeable customer support agent at Wise (formerly TransferWise). You're speaking with a customer on a live phone call.

YOUR PERSONALITY:
- You are CALM, PATIENT, and genuinely want to help the customer find what they need.
- Speak in a gentle, reassuring tone — especially when someone is worried about their money. Phrases like "Don't worry, let's figure this out together" or "You're in the right place, I can help with that" make a big difference.
- GUIDE the customer step by step. Don't dump all the information at once. Ask what they need, give the most relevant part first, then ask if they'd like more detail.
- Use contractions naturally ("you're", "it's", "we've", "that's", "I'll").
- Use calm conversational phrases: "Of course", "Absolutely", "Let me walk you through that", "That makes sense", "Good question".
- If the customer sounds confused or frustrated, slow down and acknowledge it: "I understand, that can be confusing" or "I hear you, let's sort this out."
- Be warm but professional — not overly casual. Think of a kind, experienced support person who's helped hundreds of people and knows exactly how to put someone at ease.
- Keep responses concise — 2 to 4 sentences. You're on a phone call. If more detail is needed, offer it: "Would you like me to go into a bit more detail on that?"
- Do NOT use bullet points, numbered lists, asterisks, or markdown. Everything must be natural spoken language.
- NEVER sound robotic or scripted. Vary how you start your responses.

SCOPE RULES - ABSOLUTELY STRICT:
1. You ONLY handle questions that can be answered EXACTLY by the FAQ text below. 
2. EXPLICITLY OUT OF SCOPE: You cannot help with "Mistakes and editing your transfer". If a customer says they sent money to the wrong person, entered the wrong reference, or sent the wrong amount, YOU CANNOT HELP THEM. DO NOT try to answer based on your general knowledge.
3. FORBIDDEN TOPICS: If the customer asks about refunds, cancellations, fees, accounts, or sending money to the wrong person, you MUST deflect immediately.
4. HOW TO DEFLECT: If a question is out of scope (like sending to the wrong person), say exactly this: "I completely understand. Because that involves details outside of my area, I need to connect you with a specialized colleague who can look into that for you right away. Hold on just a moment." Then IMMEDIATELY end your response with the exact tag: [DEFLECT]
5. DO NOT GUESS. If the answer is not in your FAQ text below, you must deflect.
6. When the customer says goodbye, be warm and reassuring: "You're welcome! Don't hesitate to call back if anything else comes up. Take care!"

YOUR KNOWLEDGE (the only topics you handle):

{FAQ_CONTEXT}

Remember: If ANY question falls outside these 6 topics, gently deflect with [DEFLECT]. Always speak as a calm, helpful guide on a phone call."""


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []


class ChatResponse(BaseModel):
    response: str
    action: str  # "continue" or "deflect"


def get_genai_client():
    """Lazy initialization of the Gemini client."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None
    from google import genai
    return genai.Client(api_key=api_key)


# kept as fallback for non-streaming clients
@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    client = get_genai_client()
    if not client:
        return ChatResponse(
            response="The API key is not configured. Please set the GEMINI_API_KEY in your .env file and restart the server.",
            action="deflect"
        )

    contents = []
    for msg in request.history:
        role = msg.get("role", "user")
        if role == "assistant":
            role = "model"
        contents.append({
            "role": role,
            "parts": [{"text": msg.get("content", "")}]
        })
    contents.append({
        "role": "user",
        "parts": [{"text": request.message}]
    })

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config={
                "system_instruction": SYSTEM_PROMPT,
                "temperature": 0.7,
                "max_output_tokens": 500,
            }
        )
        response_text = response.text
        action = "continue"
        if "[DEFLECT]" in response_text:
            action = "deflect"
            response_text = response_text.replace("[DEFLECT]", "").strip()
        return ChatResponse(response=response_text, action=action)

    except Exception as e:
        print(f"Error calling Gemini API: {e}")
        return ChatResponse(
            response="I'm sorry, I'm experiencing technical difficulties right now. Please try calling again in a few moments. Goodbye!",
            action="deflect"
        )


# main sse chat endpoint
@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest):
    client = get_genai_client()
    if not client:
        async def error_stream():
            data = json.dumps({"type": "chunk", "text": "The API key is not configured. Please set GEMINI_API_KEY in your .env file."})
            yield f"data: {data}\n\n"
            data = json.dumps({"type": "done", "action": "deflect"})
            yield f"data: {data}\n\n"
        return StreamingResponse(error_stream(), media_type="text/event-stream")

    contents = []
    for msg in request.history:
        role = msg.get("role", "user")
        if role == "assistant":
            role = "model"
        contents.append({
            "role": role,
            "parts": [{"text": msg.get("content", "")}]
        })
    contents.append({
        "role": "user",
        "parts": [{"text": request.message}]
    })

    async def generate():
        full_text = ""
        try:
            response_stream = client.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=contents,
                config={
                    "system_instruction": SYSTEM_PROMPT,
                    "temperature": 0.7,
                    "max_output_tokens": 500,
                }
            )

            for chunk in response_stream:
                if chunk.text:
                    full_text += chunk.text
                    data = json.dumps({"type": "chunk", "text": chunk.text})
                    yield f"data: {data}\n\n"

            # Determine action from full text
            action = "continue"
            if "[DEFLECT]" in full_text:
                action = "deflect"

            data = json.dumps({"type": "done", "action": action})
            yield f"data: {data}\n\n"

        except Exception as e:
            print(f"Error calling Gemini API: {e}")
            error_msg = "I'm sorry, I'm experiencing technical difficulties. Please try calling again shortly. Goodbye!"
            data = json.dumps({"type": "chunk", "text": error_msg})
            yield f"data: {data}\n\n"
            data = json.dumps({"type": "done", "action": "deflect"})
            yield f"data: {data}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# tts proxy via elevenlabs
ELEVENLABS_VOICE_ID = "iP95p4xoKVk53GoZ742B"  
ELEVENLABS_MODEL = "eleven_flash_v2_5"  

@app.get("/api/tts")
async def text_to_speech(text: str):
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return Response(status_code=503, content="ElevenLabs API key not configured")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream"

    async def stream_audio():
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST", url,
                headers={
                    "xi-api-key": api_key,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                json={
                    "text": text,
                    "model_id": ELEVENLABS_MODEL,
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.75,
                        "style": 0.4,
                    }
                }
            ) as resp:
                if resp.status_code != 200:
                    yield b""
                    return
                async for chunk in resp.aiter_bytes():
                    yield chunk

    return StreamingResponse(stream_audio(), media_type="audio/mpeg", headers={"Cache-Control": "no-cache"})


# Serve static files from public directory
public_dir = os.path.join(script_dir, "public")
app.mount("/public", StaticFiles(directory=public_dir), name="public")


@app.get("/")
async def root():
    return FileResponse(os.path.join(public_dir, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
