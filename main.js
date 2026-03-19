// 导入 face-api.js 库的所有导出成员作为 faceapi 对象
import * as faceapi from 'face-api.js';
// 导入 jQuery
import $ from 'jquery';

// --- 配置项 ---
// 模型文件的存放路径
const MODELS_PATH = './models';
// 眨眼阈值：眼部纵横比 (EAR) 小于 0.3 时认为眼睛是闭合的
const BLINK_THRESHOLD = 0.3;
// 张嘴阈值：嘴部纵横比 (MAR) 大于 0.3 时认为嘴巴是张开的
const MOUTH_OPEN_THRESHOLD = 0.1;
// 摇头阈值：角度（近似值）或偏差单位（目前逻辑中未使用此常量，而是用了相对位置判断）
const HEAD_SHAKE_THRESHOLD = 15;

// --- 状态管理 ---
// 当前应用状态，初始为 'LOADING'。可选值：LOADING, READY, BLINK, MOUTH, SHAKE, COMPLETED
let state = 'LOADING';
// 用于存储摄像头视频流对象
let videoStream = null;
// 用于存储检测循环的 setInterval ID，以便后续清除
let detectionLoopId = null;


let isStartLiveness = false;
// --- 指标追踪 ---
// 眨眼计数器，记录闭眼的帧数或次数
let blinkCounter = 0;
// 张嘴计数器，记录张嘴的帧数
let mouthOpenCounter = 0;
let mouthMarBaseline = 0;
let headTurnLeftCounter = 0;
let headTurnRightCounter = 0;
// 摇头数据，记录摇头动作的时间戳
let headShakeData = {
    // 向左看的时间戳
    left: 0, // 向右看的时间戳
    right: 0, // 上一次的 X 坐标（暂未使用）
    lastX: 0
};

// 最佳人脸数据，用于上传
let bestFace = {
    blob: null, score: 0
};

// --- DOM 元素引用 ---
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

// 新增的 DOM 元素引用
const preCheckUI = document.getElementById('pre-check-ui');
const livenessControls = document.getElementById('liveness-controls');
const startLivenessBtn = document.getElementById('start-liveness-btn');
const mainTitle = document.getElementById('main-title');
const preCheckBanner = document.getElementById('pre-check-banner');
const preCheckTips = document.getElementById('pre-check-tips');
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownNumber = document.getElementById('countdown-number');
const step1El = document.getElementById('step-1');
const step2El = document.getElementById('step-2');
const step3El = document.getElementById('step-3');
const stepArrows1El = document.getElementById('step-arrows-1');
const stepArrows2El = document.getElementById('step-arrows-2');
const stepperEl = document.getElementById('stepper');
const successScreenEl = document.getElementById('success-screen');
const successBadgeEl = document.getElementById('success-badge');
const failureScreenEl = document.getElementById('failure-screen');
const failureBadgeEl = document.getElementById('failure-badge');
const retryBtn = document.getElementById('retry-btn');
const videoContainerEl = document.querySelector('.video-container');

let countdownIntervalId = null;
let livenessTimeoutId = null;

function clearLivenessTimeout() {
    if (livenessTimeoutId) {
        clearTimeout(livenessTimeoutId);
        livenessTimeoutId = null;
    }
}

function startLivenessTimeout() {
    clearLivenessTimeout();
    livenessTimeoutId = setTimeout(() => {
        if (state === 'COMPLETED' || state === 'FAILED') return;
        state = 'FAILED';
        isStartLiveness = false;
        updateUI();
    }, 15000);
}

// --- 初始化流程 ---

// 初始化函数，负责加载模型和启动摄像头
async function init() {
    // 此函数现在由按钮点击触发，主要负责启动摄像头和检测
    // 模型加载已移至页面加载时
    try {
        await startVideo();
    } catch (err) {
        console.error('Error starting video and detection:', err);
        statusEl.innerText = 'Error: ' + err.message;
    }
}

// 启动摄像头函数
async function startVideo() {
    try {
        // 请求用户媒体设备（摄像头）
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: {
                // 理想宽度
                width: {ideal: 640}, // 理想高度
                height: {ideal: 480}, // 优先使用前置摄像头
                facingMode: 'user'
            }
        });
        // 将视频流赋值给 video 元素的 srcObject 属性，从而实时显示画面
        video.srcObject = videoStream;

        // 当视频元数据加载完成时触发
        video.onloadedmetadata = () => {
            // 开始播放视频
            video.play();
            // 调用视频播放后的回调函数，开始检测循环
            onVideoPlay();
        };
    } catch (err) {
        // 捕获摄像头访问错误（如用户拒绝权限）
        console.error('Camera error:', err);
        // 在界面上显示权限被拒绝或错误信息
        statusEl.innerText = 'Camera access denied or error: ' + err.message;
    }
}

// 视频播放后的处理函数
function onVideoPlay() {
    // 获取视频的实际显示尺寸
    const displaySize = {width: video.videoWidth, height: video.videoHeight};

    // 动态调整容器比例，适配不同设备的摄像头分辨率（如 4:3 或 16:9）
    // 防止 object-fit: cover 裁剪导致的人脸框错位
    const videoContainer = document.querySelector('.video-container');
    if (videoContainer && video.videoWidth && video.videoHeight) {
        const ratio = video.videoWidth / video.videoHeight;
        videoContainer.style.aspectRatio = `${ratio}`;
    }

    // 调整 canvas 的尺寸以匹配视频尺寸
    faceapi.matchDimensions(canvas, displaySize);

    // 更新状态为 'READY'
    state = 'READY';

    // 设置定时器，每 50 毫秒（20 FPS）执行一次检测循环
    detectionLoopId = setInterval(async () => {
        // 如果视频暂停或结束，则跳过本次检测
        if (video.paused || video.ended || !isStartLiveness) return;

        // 检测所有人脸
        // 使用 TinyFaceDetectorOptions 选项（配合加载的模型）
        // withFaceLandmarks() 表示同时检测面部特征点
        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
            .withFaceLandmarks();


        // 将检测结果调整为当前显示尺寸（canvas 尺寸）
        const resizedDetections = faceapi.resizeResults(detections, displaySize);

        // 获取 canvas 的 2D 绘图上下文
        const ctx = canvas.getContext('2d');
        // 清除上一帧的绘制内容
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // 在 canvas 上绘制检测到的人脸框（可选）
        faceapi.draw.drawDetections(canvas, resizedDetections);
        // 在 canvas 上绘制面部 68 个特征点（可选，当前被注释掉）
        faceapi.draw.drawFaceLandmarks(canvas, resizedDetections);

        // 如果检测到至少一张人脸
        if (detections.length > 0) {
            const face = detections[0];

            if (state === 'MOUTH' || state === 'SHAKE_LEFT' || state === 'SHAKE_RIGHT') {
                captureBestFace(face);
                processLiveness(face.landmarks);
            }
            // 更新状态文本为“检测到人脸”
            statusEl.innerText = 'Face detected';
        } else {
            // 如果未检测到人脸，更新状态文本
            statusEl.innerText = 'No face detected';
        }
    }, 50); // 设置间隔为 50ms
}

// --- 活体检测逻辑 ---

// 开始活体检测流程函数
function startLivenessTest() {
    // 倒计时后进入第一个检测项：张嘴
    state = 'MOUTH';
    // 重置所有计数器和指标
    resetMetrics();
    // 更新 UI 显示
    updateUI();
}

// 重置指标函数
function resetMetrics() {
    // 重置眨眼计数
    blinkCounter = 0;
    // 重置张嘴计数
    mouthOpenCounter = 0;
    mouthMarBaseline = 0;
    headTurnLeftCounter = 0;
    headTurnRightCounter = 0;
    // 重置摇头数据
    headShakeData = {left: 0, right: 0, lastX: 0};
    // 重置最佳人脸数据
    bestFace = {blob: null, score: 0};
}

// 更新 UI 界面函数
function updateUI(completedAction) {
    if (step1El) step1El.classList.remove('active');
    if (step2El) step2El.classList.remove('active');
    if (step3El) step3El.classList.remove('active');
    if (stepArrows1El) stepArrows1El.classList.remove('active');
    if (stepArrows2El) stepArrows2El.classList.remove('active');
    if (successScreenEl) successScreenEl.style.display = 'none';
    if (successBadgeEl) successBadgeEl.style.display = 'none';
    if (failureScreenEl) failureScreenEl.style.display = 'none';
    if (failureBadgeEl) failureBadgeEl.style.display = 'none';
    if (videoContainerEl) videoContainerEl.classList.remove('failed');
    if (stepperEl) stepperEl.style.display = 'flex';
    if (instructionEl) instructionEl.style.display = 'block';

    if (state === 'MOUTH') {
        if (step1El) step1El.classList.add('active');
        if (stepArrows1El) stepArrows1El.classList.add('active');
        instructionEl.innerText = 'Please open your mouth';
        restartBtn.style.display = 'none';
        return;
    }

    if (state === 'SHAKE_LEFT') {
        if (step1El) step1El.classList.add('active');
        if (step2El) step2El.classList.add('active');
        if (stepArrows1El) stepArrows1El.classList.add('active');
        instructionEl.innerText = 'Please turn your head slowly to the left';
        restartBtn.style.display = 'none';
        return;
    }

    if (state === 'SHAKE_RIGHT') {
        if (step1El) step1El.classList.add('active');
        if (step2El) step2El.classList.add('active');
        if (step3El) step3El.classList.add('active');
        if (stepArrows1El) stepArrows1El.classList.add('active');
        if (stepArrows2El) stepArrows2El.classList.add('active');
        instructionEl.innerText = 'Please turn your head slowly to the right';
        restartBtn.style.display = 'none';
        return;
    }

    if (state === 'COMPLETED') {
        clearLivenessTimeout();
        if (stepperEl) stepperEl.style.display = 'none';
        if (instructionEl) instructionEl.style.display = 'none';
        if (successScreenEl) successScreenEl.style.display = 'block';
        if (successBadgeEl) successBadgeEl.style.display = 'flex';
        statusEl.innerText = 'Completed';
        restartBtn.style.display = 'none';
        onCompleted();
    }

    if (state === 'FAILED') {
        clearLivenessTimeout();
        if (stepperEl) stepperEl.style.display = 'none';
        if (instructionEl) instructionEl.style.display = 'none';
        if (failureScreenEl) failureScreenEl.style.display = 'block';
        if (failureBadgeEl) failureBadgeEl.style.display = 'flex';
        if (videoContainerEl) videoContainerEl.classList.add('failed');
        statusEl.innerText = 'Failed';
        restartBtn.style.display = 'none';
    }
}


function onCompleted() {
    if (bestFace.blob) {
        statusEl.innerText = 'Completed. Uploading best face...';
        uploadFace(bestFace.blob);
    } else {
        statusEl.innerText = 'Completed, but no best face captured.';
    }
}


function uploadFace(blob) {
    const imgBestFace = document.getElementById('img_BestFace');
    if (imgBestFace) {
        imgBestFace.src = URL.createObjectURL(blob);
        imgBestFace.style.display = 'block'; // 确保显示
    }

    // 使用 jQuery 上传到 uploadAppImage 接口
    const formData = new FormData();
    // 将 blob 添加到 FormData 中，文件名为 best_face.jpg
    formData.append('file', blob, 'best_face.jpg');

    console.log("正在通过 jQuery 上传最佳人脸...");
    statusEl.innerText = 'Uploading best face...';

    $.ajax({
        url: '/uploadAppImage', // 目标接口地址
        type: 'POST', data: formData, processData: false, // 告诉 jQuery 不要处理发送的数据
        contentType: false, // 告诉 jQuery 不要设置 Content-Type 请求头
        success: function (response) {
            console.log('上传成功:', response);
            statusEl.innerText = 'Upload success!';
            alert("人脸照片已成功上传到后台。");
        }, error: function (xhr, status, error) {
            console.error('上传失败:', error);
            statusEl.innerText = 'Upload failed: ' + error;
            alert("上传失败，请检查网络或后台接口。");
        }
    });
}

// 捕获最佳人脸的逻辑
function captureBestFace(detection) {
    // 1. 获取检测置信度
    const score = detection.detection.score;

    // 2. 检查人脸是否正对前方 (通过鼻子位置判断)
    const landmarks = detection.landmarks;
    const nose = landmarks.getNose();
    const noseTip = nose[3];
    const jaw = landmarks.getJawOutline();
    const faceLeft = jaw[0].x;
    const faceRight = jaw[16].x;
    const faceWidth = faceRight - faceLeft;
    const noseRelX = (noseTip.x - faceLeft) / faceWidth;

    console.log("========11===");

    // 认为 0.45 - 0.55 是比较正的
    const isFrontal = noseRelX > 0.45 && noseRelX < 0.55;

    // 3. 如果当前人脸比之前的更好（置信度更高且正对），则保存
    // 如果之前没有保存过，或者当前分数更高且也比较正
    if (isFrontal && score > bestFace.score) {
        // 创建一个临时的 canvas 来截取当前视频帧
        const captureCanvas = document.createElement('canvas');
        captureCanvas.width = video.videoWidth;
        captureCanvas.height = video.videoHeight;
        const ctx = captureCanvas.getContext('2d');
        ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

        // 转换为 Blob
        captureCanvas.toBlob((blob) => {
            if (blob) {
                bestFace.blob = blob;
                bestFace.score = score;
                // console.log(`捕获更佳人脸: score=${score.toFixed(2)}`);
            }
        }, 'image/jpeg', 0.95);
    }
}

// 核心活体检测处理函数
function processLiveness(landmarks) {
    if (state === 'MOUTH') {
        const mouth = landmarks.getMouth();
        const mar = getMAR(mouth);
        if (!mouthMarBaseline) {
            mouthMarBaseline = mar;
        } else if (mar < 0.2) {
            mouthMarBaseline = mouthMarBaseline * 0.9 + mar * 0.1;
        }

        const dynamicThreshold = Math.max(MOUTH_OPEN_THRESHOLD, mouthMarBaseline + 0.06);

        if (mar > dynamicThreshold) {
            mouthOpenCounter++;
            if (mouthOpenCounter >= 3) {
                state = 'SHAKE_LEFT';
                mouthOpenCounter = 0;
                headTurnLeftCounter = 0;
                headTurnRightCounter = 0;
                updateUI('mouth');
                return;
            }
        } else {
            mouthOpenCounter = 0;
        }
        return;
    }

    if (state === 'SHAKE_LEFT') {
        const nose = landmarks.getNose();
        const noseTip = nose[3];
        const jaw = landmarks.getJawOutline();
        const faceLeft = jaw[0].x;
        const faceRight = jaw[16].x;
        const faceWidth = faceRight - faceLeft;
        const noseRelX = (noseTip.x - faceLeft) / faceWidth;

        if (noseRelX < 0.38) {
            headTurnLeftCounter += 1;
        } else {
            headTurnLeftCounter = 0;
        }

        if (headTurnLeftCounter > 2) {
            state = 'SHAKE_RIGHT';
            headTurnLeftCounter = 0;
            headTurnRightCounter = 0;
            updateUI('shake');
            return;
        }
    }

    if (state === 'SHAKE_RIGHT') {
        const nose = landmarks.getNose();
        const noseTip = nose[3];
        const jaw = landmarks.getJawOutline();
        const faceLeft = jaw[0].x;
        const faceRight = jaw[16].x;
        const faceWidth = faceRight - faceLeft;
        const noseRelX = (noseTip.x - faceLeft) / faceWidth;

        if (noseRelX > 0.62) {
            headTurnRightCounter += 1;
        } else {
            headTurnRightCounter = 0;
        }

        if (headTurnRightCounter > 2) {
            if (bestFace.blob) {
                state = 'COMPLETED';
                isStartLiveness = false;
                updateUI('shake');
                return;
            }
            statusEl.innerText = 'Head turn detected, looking for best frontal face...';
        }
    }
}

// --- 辅助函数 ---

// 计算眼睛纵横比 (EAR) 函数
function getEAR(eye) {
    // EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
    // eye 数组中的索引对应关系：
    // 0: 左眼角, 3: 右眼角
    // 1, 2: 上眼睑点
    // 4, 5: 下眼睑点

    // 计算垂直距离 A（p2 到 p6）
    const A = dist(eye[1], eye[5]);
    // 计算垂直距离 B（p3 到 p5）
    const B = dist(eye[2], eye[4]);
    // 计算水平距离 C（p1 到 p4）
    const C = dist(eye[0], eye[3]);

    // 返回 EAR 计算结果
    return (A + B) / (2.0 * C);
}

// 计算嘴巴纵横比 (MAR) 函数
function getMAR(mouth) {
    // 68 点模型中的嘴部点：
    // 外嘴唇：48-59 (在 getMouth() 结果中可能是 0-11)
    // face-api.js 的 getMouth() 通常返回 20 个点 (外嘴唇 + 内嘴唇)
    // 这里假设使用标准映射
    // getMouth() 返回点 48-67
    // 0-11 是外嘴唇。12-19 是内嘴唇。
    // 高度：上唇中点(51) 到 下唇中点(57) -> 对应子集索引 3 和 9
    // 宽度：左嘴角(48) 到 右嘴角(54) -> 对应子集索引 0 和 6

    // 这里选择使用外嘴唇来计算
    const p = mouth;
    // 上唇中心点：p[3] (68点中的 51)
    // 下唇中心点：p[9] (68点中的 57)
    // 左嘴角：p[0] (48)
    // 右嘴角：p[6] (54)

    // 计算垂直距离（高度）
    const height = dist(p[3], p[9]);
    // 计算水平距离（宽度）
    const width = dist(p[0], p[6]);

    // 返回高度除以宽度的比率
    return height / width;
}

// 计算两点间欧几里得距离的辅助函数
function dist(p1, p2) {
    // 使用勾股定理计算距离
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

// 绑定重新开始按钮的点击事件
if (restartBtn) {
    restartBtn.addEventListener('click', () => {
        // 重新开始活体检测流程
        startLivenessTest();
        // 隐藏重新开始按钮
        restartBtn.style.display = 'none';
    });
}

// 程序入口：页面加载后立即加载模型并启动摄像头
document.addEventListener('DOMContentLoaded', async () => {
    try {
        isStartLiveness = false;
        startLivenessBtn.disabled = true;
        startLivenessBtn.innerText = '正在加载模型...';

        await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_PATH), faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_PATH),]);
        startLivenessBtn.disabled = false;
        startLivenessBtn.innerText = '立即开始';
        await startVideo(); // 立即启动摄像头

    } catch (err) {
        console.error('Initialization error:', err);
        mainTitle.innerText = 'Error!';
        startLivenessBtn.innerText = '初始化失败';
        startLivenessBtn.disabled = true;
    }
});

// 绑定“立即开始”按钮的点击事件
startLivenessBtn.addEventListener('click', () => {
    if (startLivenessBtn.disabled) return;

    startLivenessBtn.disabled = true;
    startLivenessBtn.innerText = '倒计时中...';
    if (preCheckTips) preCheckTips.style.display = 'none';
    if (preCheckBanner) {
        preCheckBanner.innerText = '请确保人脸在圆圈内，倒计时结束后开始检测';
    }

    if (countdownOverlay) countdownOverlay.style.display = 'flex';
    let remaining = 5;
    if (countdownNumber) countdownNumber.innerText = String(remaining);

    if (countdownIntervalId) clearInterval(countdownIntervalId);
    countdownIntervalId = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            clearInterval(countdownIntervalId);
            countdownIntervalId = null;

            if (countdownOverlay) countdownOverlay.style.display = 'none';
            if (preCheckUI) preCheckUI.style.display = 'none';
            if (livenessControls) livenessControls.style.display = 'block';
            if (mainTitle) mainTitle.innerText = 'Liveness Check';

            isStartLiveness = true;
            startLivenessTest();
            startLivenessTimeout();
            return;
        }
        if (countdownNumber) countdownNumber.innerText = String(remaining);
    }, 1000);
});

if (retryBtn) {
    retryBtn.addEventListener('click', () => {
        if (livenessControls) livenessControls.style.display = 'block';
        if (mainTitle) mainTitle.innerText = 'Liveness Check';
        isStartLiveness = true;
        startLivenessTest();
        startLivenessTimeout();
    });
}
