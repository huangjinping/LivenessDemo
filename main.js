import * as faceapi from 'face-api.js';

// Configuration
const MODELS_PATH = './models';
const BLINK_THRESHOLD = 0.3; // Eye Aspect Ratio < 0.3 means closed
const MOUTH_OPEN_THRESHOLD = 0.3; // Mouth Aspect Ratio > 0.3 means open
const HEAD_SHAKE_THRESHOLD = 15; // Degrees (approximate) or deviation unit

// State
let state = 'LOADING'; // LOADING, READY, BLINK, MOUTH, SHAKE, COMPLETED
let videoStream = null;
let detectionLoopId = null;

// Metrics tracking
let blinkCounter = 0;
let mouthOpenCounter = 0;
let headShakeData = {
  left: 0,
  right: 0,
  lastX: 0
};

// Elements
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const instructionEl = document.getElementById('instruction');
const checklist = {
  blink: document.getElementById('task-blink'),
  mouth: document.getElementById('task-mouth'),
  shake: document.getElementById('task-shake')
};
const restartBtn = document.getElementById('restart-btn');

// --- Initialization ---

async function init() {
  try {
    statusEl.innerText = 'Loading models...';

    // Load models
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_PATH),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_PATH)
      // faceapi.nets.faceExpressionNet.loadFromUri(MODELS_PATH) // Not strictly needed
    ]);

    statusEl.innerText = 'Models loaded. Starting camera...';
    await startVideo();
  } catch (err) {
    console.error('Initialization error:', err);
    statusEl.innerText = 'Error: ' + err.message;
  }
}

async function startVideo() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user' // Front camera
      }
    });
    video.srcObject = videoStream;

    video.onloadedmetadata = () => {
      video.play();
      onVideoPlay();
    };
  } catch (err) {
    console.error('Camera error:', err);
    statusEl.innerText = 'Camera access denied or error: ' + err.message;
  }
}

function onVideoPlay() {
  const displaySize = { width: video.videoWidth, height: video.videoHeight };
  faceapi.matchDimensions(canvas, displaySize);

  state = 'READY';
  startLivenessTest();

  detectionLoopId = setInterval(async () => {
    if (video.paused || video.ended) return;

    // Detect face
    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks();


    const resizedDetections = faceapi.resizeResults(detections, displaySize);

    // Draw
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    faceapi.draw.drawDetections(canvas, resizedDetections); // Optional: draw box 人脸的位置
    // faceapi.draw.drawFaceLandmarks(canvas, resizedDetections);//画出人脸的68 个点面部特征点

    if (detections.length > 0) {
      processLiveness(detections[0].landmarks);
      statusEl.innerText = 'Face detected';
    } else {
      statusEl.innerText = 'No face detected';
    }
  }, 50); // 50ms interval (20 FPS)
}

// --- Liveness Logic ---

function startLivenessTest() {
  state = 'BLINK';
  resetMetrics();
  updateUI();
}

function resetMetrics() {
  blinkCounter = 0;
  mouthOpenCounter = 0;
  headShakeData = { left: 0, right: 0, lastX: 0 };
}

function updateUI() {
  // Reset all
  Object.values(checklist).forEach(el => {
    el.classList.remove('active', 'completed');
    el.classList.add('pending');
  });

  if (state === 'BLINK') {
    instructionEl.innerText = 'Please Blink Your Eyes (请眨眼)';
    checklist.blink.classList.remove('pending');
    checklist.blink.classList.add('active');
  } else if (state === 'MOUTH') {
    checklist.blink.classList.remove('pending');
    checklist.blink.classList.add('completed');
    instructionEl.innerText = 'Please Open Your Mouth (请张嘴)';
    checklist.mouth.classList.remove('pending');
    checklist.mouth.classList.add('active');
  } else if (state === 'SHAKE') {
    checklist.blink.classList.remove('pending');
    checklist.blink.classList.add('completed');
    checklist.mouth.classList.remove('pending');
    checklist.mouth.classList.add('completed');
    instructionEl.innerText = 'Please Shake Your Head (请摇头)';
    checklist.shake.classList.remove('pending');
    checklist.shake.classList.add('active');
  } else if (state === 'COMPLETED') {
    Object.values(checklist).forEach(el => {
        el.classList.remove('pending', 'active');
        el.classList.add('completed');
    });
    instructionEl.innerText = 'Verification Success! (验证通过)';
    statusEl.innerText = 'Completed';
    restartBtn.style.display = 'inline-block';
  }
}

function processLiveness(landmarks) {
  if (state === 'COMPLETED') return;

  // 1. Blink Detection
  if (state === 'BLINK') {
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const leftEAR = getEAR(leftEye);
    const rightEAR = getEAR(rightEye);
    const avgEAR = (leftEAR + rightEAR) / 2;

    // Simple state machine for blink: Open -> Closed -> Open
    // But since we just poll, we can count frames where eyes are closed.
    // Better: Detect transition.

    // For simplicity: if EAR < threshold, we register a "blinked" state?
    // No, we need to ensure they open it again.
    // Let's use a simple counter for closed frames.

    if (avgEAR < BLINK_THRESHOLD) {
      blinkCounter++;
      statusEl.innerText = `Eyes Closed: ${blinkCounter} (EAR: ${avgEAR.toFixed(2)})`;
    } else {
      if (blinkCounter >= 1) { // Was closed for at least 1 frame
        // Valid blink
        console.log('Blink detected!');
        state = 'MOUTH';
        updateUI();
      }
      blinkCounter = 0;
      if (state === 'BLINK') {
        statusEl.innerText = `Eyes Open (EAR: ${avgEAR.toFixed(2)})`;
      }
    }
  }

  // 2. Mouth Open Detection
  else if (state === 'MOUTH') {
    const mouth = landmarks.getMouth();
    const mar = getMAR(mouth);

    if (mar > MOUTH_OPEN_THRESHOLD) {
      mouthOpenCounter++;
      statusEl.innerText = `Mouth Open: ${mouthOpenCounter} (MAR: ${mar.toFixed(2)})`;
    } else {
      if (mouthOpenCounter > 2) { // Held open for a bit
        console.log('Mouth open detected!');
        state = 'SHAKE';
        updateUI();
      }
      mouthOpenCounter = 0;
      if (state === 'MOUTH') {
        statusEl.innerText = `Mouth Closed (MAR: ${mar.toFixed(2)})`;
      }
    }
  }

  // 3. Head Shake Detection
  else if (state === 'SHAKE') {
    const nose = landmarks.getNose();
    const noseTip = nose[3]; // Approx tip
    // Normalize x position relative to face width to be scale-invariant
    const jaw = landmarks.getJawOutline();
    const faceLeft = jaw[0].x;
    const faceRight = jaw[16].x;
    const faceWidth = faceRight - faceLeft;

    // Nose relative position (0.0 to 1.0)
    const noseRelX = (noseTip.x - faceLeft) / faceWidth;

    // Center is approx 0.5
    // Look left: nose moves left (ratio decreases, e.g. < 0.4)
    // Look right: nose moves right (ratio increases, e.g. > 0.6)

    if (noseRelX < 0.4) {
      headShakeData.left = Date.now();
    }
    if (noseRelX > 0.6) {
      headShakeData.right = Date.now();
    }

    if (headShakeData.left && headShakeData.right &&
        Math.abs(headShakeData.left - headShakeData.right) < 2000) { // Shake within 2 seconds
      console.log('Shake detected!');
      state = 'COMPLETED';
      updateUI();
    }
  }
}

// --- Helpers ---

function getEAR(eye) {
  // EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
  // Indices in eye array:
  // 0: left corner, 3: right corner
  // 1, 2: top
  // 4, 5: bottom

  const A = dist(eye[1], eye[5]);
  const B = dist(eye[2], eye[4]);
  const C = dist(eye[0], eye[3]);

  return (A + B) / (2.0 * C);
}

function getMAR(mouth) {
  // Mouth points in 68-point model:
  // Outer lip: 48-59 (0-11 in getMouth() result?)
  // face-api.js getMouth() returns 20 points usually (outer + inner)
  // Let's check docs or assume standard 68 point indices map.
  // getMouth() returns points 48-67.
  // 0-11 are outer lips. 12-19 are inner lips.
  // Height: Top(51) to Bottom(57) -> indices 3 and 9 in the subset
  // Width: Left(48) to Right(54) -> indices 0 and 6

  // Use inner lip for open mouth detection usually? Or outer.
  // Let's use outer.
  const p = mouth;
  // Top lip central: p[3] (index 51 in 68-pts)
  // Bottom lip central: p[9] (index 57 in 68-pts)
  // Left corner: p[0] (48)
  // Right corner: p[6] (54)

  const height = dist(p[3], p[9]); // Vertical
  const width = dist(p[0], p[6]); // Horizontal

  return height / width;
}

function dist(p1, p2) {
  return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

// Restart
restartBtn.addEventListener('click', () => {
  startLivenessTest();
  restartBtn.style.display = 'none';
});

// Start
init();
