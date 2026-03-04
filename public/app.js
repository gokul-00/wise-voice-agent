// wise voice agent core
// handles full duplex streaming and stt/tts

const API_URL = '/api/chat/stream';
const TTS_URL = '/api/tts';

// dom elements
const idleScreen = document.getElementById('idle-screen');
const callScreen = document.getElementById('call-screen');
const endedScreen = document.getElementById('ended-screen');

const startCallBtn = document.getElementById('start-call-btn');
const endCallBtn = document.getElementById('end-call-btn');
const newCallBtn = document.getElementById('new-call-btn');
const muteBtn = document.getElementById('mute-btn');
const muteIconOn = document.getElementById('mute-icon-on');
const muteIconOff = document.getElementById('mute-icon-off');

const callStatus = document.getElementById('call-status');
const callTimerEl = document.getElementById('call-timer');
const transcript = document.getElementById('transcript');
const visualizer = document.getElementById('voice-visualizer');
const stateIndicator = document.getElementById('state-indicator');
const stateText = document.getElementById('state-text');
const endedDuration = document.getElementById('ended-duration');
const endedReason = document.getElementById('ended-reason');
const headerStatusDot = document.getElementById('header-status-dot');
const headerStatusText = document.getElementById('header-status-text');
const ratingCircles = document.querySelectorAll('.rating-circle');

const stillThereOverlay = document.getElementById('still-there-overlay');
const stillThereYes = document.getElementById('still-there-yes');
const stillThereEnd = document.getElementById('still-there-end');

// app state
let recognition = null;
let synth = window.speechSynthesis;
let conversationHistory = [];
let callActive = false;
let isMuted = false;
let isSpeaking = false;
let isProcessing = false;
let callStartTime = null;
let timerInterval = null;
let endReason = '';
let useElevenLabs = true;

// Active fetch controllers (for interruption)
let llmAbortController = null;
let currentTtsControllers = [];

// audio playback queue
let audioQueue = [];
let ttsPlaying = false;
let currentAudio = null;

// silence tracking
let silenceTimer = null;
const SILENCE_TIMEOUT = 20000;

// helpers
function showScreen(screen) {
    [idleScreen, callScreen, endedScreen].forEach(s => s.classList.remove('active'));
    screen.classList.add('active');

    // Update Header Status
    if (screen === callScreen) {
        headerStatusDot.classList.add('active');
        headerStatusText.textContent = 'ONLINE';
    } else if (screen === endedScreen) {
        headerStatusDot.classList.remove('active');
        headerStatusText.textContent = 'CALL ENDED';
    } else {
        headerStatusDot.classList.remove('active');
        headerStatusText.textContent = 'OFFLINE';
    }
}

// ---- Timer ----
function startTimer() {
    callStartTime = Date.now();
    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        callTimerEl.textContent = `${mins}:${secs}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
    return callTimerEl.textContent;
}

// ---- State Indicators ----
function setVoiceState(state) {
    visualizer.className = 'voice-visualizer';
    stateIndicator.className = 'state-indicator';

    switch (state) {
        case 'listening':
            visualizer.classList.add('listening');
            stateIndicator.classList.add('listening');
            stateText.textContent = '🎤 Listening...';
            callStatus.textContent = 'In call — Listening';
            break;
        case 'processing':
            visualizer.classList.add('processing');
            stateIndicator.classList.add('processing');
            stateText.textContent = '⏳ Thinking...';
            callStatus.textContent = 'In call — Processing';
            break;
        case 'speaking':
            visualizer.classList.add('speaking');
            stateIndicator.classList.add('speaking');
            stateText.textContent = '🔊 Gokul is speaking...';
            callStatus.textContent = 'In call — Speaking';
            break;
        default:
            stateText.textContent = 'Connecting...';
            callStatus.textContent = 'Connecting...';
    }
}

// ---- Transcript ----
function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message message--${role}`;

    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'You' : 'Gokul';

    const content = document.createElement('span');
    content.className = 'message-content';
    content.textContent = text;

    div.appendChild(label);
    div.appendChild(content);
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
    return content;
}

function updateMessageContent(contentEl, text) {
    contentEl.textContent = text;
    transcript.scrollTop = transcript.scrollHeight;
}

// ---- Full Duplex Interruption Engine ----
function cancelAllOutput() {
    // 1. Cancel LLM stream if running
    if (llmAbortController) {
        llmAbortController.abort();
        llmAbortController = null;
    }

    // 2. Stop current audio
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = "";
        currentAudio = null;
    }
    synth.cancel();

    // 3. Clear pending TTS fetches
    currentTtsControllers.forEach(c => c.abort());
    currentTtsControllers = [];

    // 4. Empty playback queue
    audioQueue = [];
    ttsPlaying = false;
    isSpeaking = false;
    isProcessing = false;
}

// ---- Speech Recognition (STT) ----
function initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert('Speech Recognition is not supported in this browser. Please use Chrome or Edge.');
        return null;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                const text = event.results[i][0].transcript.trim();

                // Exclude very short noise if we are speaking to avoid echo self-interruptions
                if (text && text.length > 2) {
                    resetSilenceTimer();
                    dismissStillThere();

                    // If agent is speaking or thinking, interrupt them!
                    if (isSpeaking || isProcessing) {
                        console.log("Interrupting agent with:", text);
                        cancelAllOutput();
                    }

                    handleUserSpeech(text);
                }
            }
        }
    };

    rec.onerror = (event) => {
        console.log('Speech recognition error:', event.error);
        if (callActive && !isMuted && event.error !== 'not-allowed') {
            setTimeout(() => startListening(), 300);
        }
    };

    rec.onend = () => {
        // ALWAYS restart listening in full-duplex unless muted or call ended
        if (callActive && !isMuted) {
            setTimeout(() => startListening(), 200);
        }
    };

    return rec;
}

function startListening() {
    if (!callActive || isMuted) return;
    try {
        recognition.start();
        if (!isSpeaking && !isProcessing) {
            setVoiceState('listening');
        }
    } catch (e) {
        // Already started
    }
}

function stopListening() {
    try { recognition.stop(); } catch (e) { /* not running */ }
}

// ---- Pre-fetch TTS Audio (Background) ----
function fetchElevenLabsAudio(text) {
    if (!useElevenLabs) return Promise.resolve({ type: 'browser', text });

    // Instead of downloading the whole MP3 via fetch, we return the stream URL directly.
    // The Audio element will natively stream the bytes as they are generated by ElevenLabs.
    const controller = new AbortController();
    currentTtsControllers.push(controller);

    const url = `${TTS_URL}?text=${encodeURIComponent(text)}`;
    return Promise.resolve({ type: 'elevenlabs', url: url, controller });
}

// Queue sentence for background download
function enqueueTTS(sentence) {
    // Start fetching audio IMMEDIATELY in the background
    const promise = useElevenLabs ? fetchElevenLabsAudio(sentence) : Promise.resolve({ type: 'browser', text: sentence });

    audioQueue.push({ text: sentence, promise });

    if (!ttsPlaying) {
        playNextInQueue();
    }
}

// Play out the queue sequentially as downloads finish
async function playNextInQueue() {
    if (audioQueue.length === 0 || !callActive) {
        ttsPlaying = false;
        isSpeaking = false;
        if (!isProcessing && callActive) {
            setVoiceState('listening');
            startSilenceTimer();
        }
        return;
    }

    ttsPlaying = true;
    isSpeaking = true;
    setVoiceState('speaking');

    const item = audioQueue.shift();
    const result = await item.promise; // Waits for background fetch if not done yet

    if (result.type === 'aborted' || !callActive) return;

    if (result.type === 'elevenlabs') {
        // Remove controller from list since we're playing it
        currentTtsControllers = currentTtsControllers.filter(c => c !== result.controller);

        await new Promise((resolve) => {
            currentAudio = new Audio(result.url);
            currentAudio.onended = () => {
                currentAudio = null;
                resolve();
            };
            currentAudio.onerror = () => {
                currentAudio = null;
                resolve();
            };
            currentAudio.play().catch(() => {
                currentAudio = null;
                resolve();
            });
        });
    } else {
        await browserSpeak(result.text);
    }

    // Move to next sentence instantaneously
    playNextInQueue();
}

function browserSpeak(text) {
    return new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.pitch = 1.05;

        // Find best male voice for Gokul fallback
        const voices = synth.getVoices();
        const preferred = voices.find(v => v.name.includes('David') || v.name.includes('Mark'))
            || voices.find(v => v.lang.startsWith('en'));

        if (preferred) utterance.voice = preferred;

        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        synth.speak(utterance);
    });
}

// ---- Streaming API Communication ----
async function sendToBackendStreaming(message) {
    const contentEl = addMessage('agent', '');
    let fullText = '';
    let sentenceBuffer = '';
    let action = 'continue';

    llmAbortController = new AbortController();

    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: message,
                history: conversationHistory
            }),
            signal: llmAbortController.signal
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!callActive) break;

            const text = decoder.decode(value);
            const lines = text.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const jsonStr = line.slice(6).trim();
                if (!jsonStr) continue;

                try {
                    const event = JSON.parse(jsonStr);

                    if (event.type === 'chunk') {
                        let chunk = event.text.replace('[DEFLECT]', '');
                        fullText += chunk;
                        sentenceBuffer += chunk;

                        updateMessageContent(contentEl, fullText);

                        const sentences = splitSentences(sentenceBuffer);
                        if (sentences.ready.length > 0) {
                            for (const sentence of sentences.ready) {
                                if (sentence.trim()) enqueueTTS(sentence.trim());
                            }
                            sentenceBuffer = sentences.remaining;
                        }
                    } else if (event.type === 'done') {
                        action = event.action;
                    }
                } catch (e) { /* ignore chunk error */ }
            }
        }

        if (sentenceBuffer.trim()) {
            enqueueTTS(sentenceBuffer.trim());
        }

        return { response: fullText, action };

    } catch (err) {
        if (err.name === 'AbortError') {
            return { response: fullText, action: 'aborted' };
        }
        console.error('Streaming API error:', err);
        const errorMsg = "I'm having a technical issue, but I'm still here.";
        updateMessageContent(contentEl, errorMsg);
        enqueueTTS(errorMsg);
        return { response: errorMsg, action: 'continue' };
    } finally {
        llmAbortController = null;
    }
}

function splitSentences(text) {
    const ready = [];
    // Split on periods, exclamation marks, question marks, commas, semi-colons, and newlines
    // This creates smaller phrases, meaning TTFB (Time to First Byte) for audio is nearly instant.
    const regex = /[^.!?,\-;:\n]*[.!?,\-;:\n]+[\s]*/g;
    let match;
    let lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
        ready.push(match[0]);
        lastIndex = regex.lastIndex;
    }
    return { ready, remaining: text.slice(lastIndex) };
}

// ---- Conversation Flow ----
async function handleUserSpeech(text) {
    if (!callActive) return;

    isProcessing = true;
    clearSilenceTimer();

    // DO NOT STOP LISTENING. Leave the mic hot.
    setVoiceState('processing');

    addMessage('user', text);
    conversationHistory.push({ role: 'user', content: text });

    const result = await sendToBackendStreaming(text);

    if (!callActive || result.action === 'aborted') return;

    conversationHistory.push({ role: 'assistant', content: result.response });
    isProcessing = false;

    if (result.action === 'deflect') {
        endReason = 'Transferred to human agent';
        waitForTTSThenEnd();
        return;
    }

    // If playback finished before fetch completed, resume listening state
    if (!ttsPlaying && audioQueue.length === 0) {
        isSpeaking = false;
        setVoiceState('listening');
        startSilenceTimer();
    }
}

function waitForTTSThenEnd() {
    const check = setInterval(() => {
        if (!ttsPlaying && audioQueue.length === 0) {
            clearInterval(check);
            setTimeout(() => endCall(), 1000);
        }
    }, 200);
}

// ---- Silence Detection ----
function startSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
        if (callActive && !isSpeaking && !isProcessing) {
            showStillThere();
        }
    }, SILENCE_TIMEOUT);
}

function clearSilenceTimer() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
}

function resetSilenceTimer() {
    clearSilenceTimer();
    startSilenceTimer();
}

function showStillThere() {
    if (stillThereOverlay) {
        stillThereOverlay.classList.add('visible');
        stateText.textContent = '🤔 Still there?';
    }
}

function dismissStillThere() {
    if (stillThereOverlay) {
        stillThereOverlay.classList.remove('visible');
    }
}

// ---- Call Lifecycle ----
async function startCall() {
    callActive = true;
    conversationHistory = [];
    transcript.innerHTML = '';
    endReason = '';

    useElevenLabs = true;
    cancelAllOutput(); // Resets all states and queues

    recognition = initRecognition();
    if (!recognition) return;

    showScreen(callScreen);
    startTimer();
    setVoiceState('listening');
    callStatus.textContent = 'Connected';

    startListening();
    startSilenceTimer();

    const greeting = "Hi there, thanks for calling Wise support. My name's Gokul. I'm here to help you with anything about your transfers. What can I help you with today?";
    addMessage('agent', greeting);
    conversationHistory.push({ role: 'assistant', content: greeting });
    enqueueTTS(greeting);
}

function endCall() {
    callActive = false;
    clearSilenceTimer();
    dismissStillThere();

    cancelAllOutput();
    stopListening();

    const duration = stopTimer();
    endedDuration.textContent = `Duration: ${duration}`;
    endedReason.textContent = endReason || '';

    showScreen(endedScreen);
}

// ---- Mute Toggle ----
function toggleMute() {
    isMuted = !isMuted;
    muteBtn.classList.toggle('active', isMuted);
    muteIconOn.style.display = isMuted ? 'none' : 'block';
    muteIconOff.style.display = isMuted ? 'block' : 'none';

    if (isMuted) {
        stopListening();
        stateText.textContent = '🔇 Muted';
    } else {
        startListening();
        if (!isSpeaking && !isProcessing) setVoiceState('listening');
    }
}

// ---- Event Listeners ----
startCallBtn.addEventListener('click', startCall);
endCallBtn.addEventListener('click', () => {
    endReason = 'You ended the call';
    endCall();
});
newCallBtn.addEventListener('click', () => showScreen(idleScreen));
muteBtn.addEventListener('click', toggleMute);

if (stillThereYes) {
    stillThereYes.addEventListener('click', () => {
        dismissStillThere();
        resetSilenceTimer();
        if (callActive && !isSpeaking && !isProcessing) {
            const nudge = "No worries, take your time! Is there anything else I can help you with?";
            addMessage('agent', nudge);
            conversationHistory.push({ role: 'assistant', content: nudge });
            enqueueTTS(nudge);
        }
    });
}

if (stillThereEnd) {
    stillThereEnd.addEventListener('click', () => {
        endReason = 'Call ended due to inactivity';
        dismissStillThere();
        const goodbye = "Alright, it seems like you're all set. Thanks for calling Wise support! Have a great day!";
        addMessage('agent', goodbye);
        conversationHistory.push({ role: 'assistant', content: goodbye });

        enqueueTTS(goodbye);
        waitForTTSThenEnd();
    });
}

// Preload browser voices
if (synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = () => synth.getVoices();
}
synth.getVoices();

// ---- Feedback Rating Interaction ----
if (ratingCircles) {
    ratingCircles.forEach(circle => {
        circle.addEventListener('click', () => {
            // Remove active from all
            ratingCircles.forEach(c => c.classList.remove('active'));
            // Add active to clicked
            circle.classList.add('active');
        });
    });
}
