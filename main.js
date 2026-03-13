// 导入 face-api.js 库的所有导出成员作为 faceapi 对象
import * as faceapi from 'face-api.js';

// --- 配置项 ---
// 模型文件的存放路径
const MODELS_PATH = './models';
// 眨眼阈值：眼部纵横比 (EAR) 小于 0.3 时认为眼睛是闭合的
const BLINK_THRESHOLD = 0.3;
// 张嘴阈值：嘴部纵横比 (MAR) 大于 0.3 时认为嘴巴是张开的
const MOUTH_OPEN_THRESHOLD = 0.3;
// 摇头阈值：角度（近似值）或偏差单位（目前逻辑中未使用此常量，而是用了相对位置判断）
const HEAD_SHAKE_THRESHOLD = 15;

// --- 状态管理 ---
// 当前应用状态，初始为 'LOADING'。可选值：LOADING, READY, BLINK, MOUTH, SHAKE, COMPLETED
let state = 'LOADING';
// 用于存储摄像头视频流对象
let videoStream = null;
// 用于存储检测循环的 setInterval ID，以便后续清除
let detectionLoopId = null;

// --- 指标追踪 ---
// 眨眼计数器，记录闭眼的帧数或次数
let blinkCounter = 0;
// 张嘴计数器，记录张嘴的帧数
let mouthOpenCounter = 0;
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
// 获取视频元素，用于显示摄像头画面
const video = document.getElementById('video');
// 获取 canvas 元素，用于绘制面部识别结果
const canvas = document.getElementById('overlay');
// 获取状态显示元素，用于展示当前检测状态文本
const statusEl = document.getElementById('status');
// 获取指令提示元素，用于告诉用户下一步做什么
const instructionEl = document.getElementById('instruction');
// 获取任务清单元素对象
const checklist = {
    // 眨眼任务的 DOM 元素
    blink: document.getElementById('task-blink'), // 张嘴任务的 DOM 元素
    mouth: document.getElementById('task-mouth'), // 摇头任务的 DOM 元素
    shake: document.getElementById('task-shake')
};
// 获取重新开始按钮元素
const restartBtn = document.getElementById('restart-btn');

// --- 初始化流程 ---

// 初始化函数，负责加载模型和启动摄像头
async function init() {
    try {
        // 更新状态提示为“正在加载模型...”
        statusEl.innerText = 'Loading models...';

        // 并行加载所需的 AI 模型
        await Promise.all([// 加载微型人脸检测器模型（轻量级，速度快）
            faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_PATH), // 加载 68 点面部特征点检测模型（用于识别眼、嘴、鼻等位置）
            faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_PATH), // faceapi.nets.faceExpressionNet.loadFromUri(MODELS_PATH) // 表情识别模型（本项目暂不需要）
        ]);

        // 更新状态提示为“模型加载完毕，正在启动摄像头...”
        statusEl.innerText = 'Models loaded. Starting camera...';
        // 调用启动摄像头函数
        await startVideo();
    } catch (err) {
        // 捕获初始化过程中的错误并打印到控制台
        console.error('Initialization error:', err);
        // 在界面上显示错误信息
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
    // 开始活体检测流程
    startLivenessTest();

    // 设置定时器，每 50 毫秒（20 FPS）执行一次检测循环
    detectionLoopId = setInterval(async () => {
        // 如果视频暂停或结束，则跳过本次检测
        if (video.paused || video.ended) return;

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
            // 尝试捕获最佳人脸（只要在检测状态且尚未完成）
            if (state === 'LIVENESS_CHECK') {
                captureBestFace(face);
            }

            // 处理活体检测逻辑，传入第一张人脸的特征点
            processLiveness(face.landmarks);
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
    // 设置初始检测状态为“LIVENESS_CHECK”，表示等待任一动作
    state = 'LIVENESS_CHECK';
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
    // 重置摇头数据
    headShakeData = {left: 0, right: 0, lastX: 0};
    // 重置最佳人脸数据
    bestFace = {blob: null, score: 0};
}

// 更新 UI 界面函数
function updateUI(completedAction) {
    // 重置所有任务列表项的样式
    Object.values(checklist).forEach(el => {
        el.classList.remove('active', 'completed');
        el.classList.add('pending');
    });

    if (state === 'LIVENESS_CHECK') {
        // 设置提示语：请执行任一动作
        instructionEl.innerText = 'Blink, Open Mouth, or Shake Head (请完成任一动作)';
        // 将所有任务标记为 active，表示都在等待中
        Object.values(checklist).forEach(el => {
            el.classList.remove('pending');
            el.classList.add('active');
        });
    } else if (state === 'COMPLETED') {
        // 将所有任务标记为 pending (未完成)
        Object.values(checklist).forEach(el => {
            el.classList.remove('active');
            el.classList.add('pending');
        });
        // 高亮显示已完成的动作
        if (completedAction && checklist[completedAction]) {
            checklist[completedAction].classList.remove('pending', 'active');
            checklist[completedAction].classList.add('completed');
        }
        
        // 设置提示语：验证通过
        instructionEl.innerText = 'Verification Success! (验证通过)';
        // 更新状态栏文本
        statusEl.innerText = 'Completed';
        // 显示重新开始按钮
        restartBtn.style.display = 'inline-block';
        onCompleted();
    }
}


function onCompleted() {
    if (bestFace.blob) {
        console.log("最佳人脸 Blob:", bestFace.blob);
        // 示例：展示图片
        const imgUrl = URL.createObjectURL(bestFace.blob);
        const img = new Image();
        img.src = imgUrl;
        img.style.position = 'fixed';
        img.style.bottom = '10px';
        img.style.right = '10px';
        img.style.width = '100px';
        img.style.border = '2px solid #00ff00';
        img.title = '最佳抓拍';
        document.body.appendChild(img);

        // 提示用户
        statusEl.innerText = 'Completed. Best face captured!';
        alert("验证完成！已获取最佳人脸照片，准备上传。");

        // TODO: 在这里执行上传逻辑
        uploadFace(bestFace.blob);
    } else {
        alert("验证完成，但未能捕获清晰人脸。");
    }
}


function uploadFace(blob) {
    const imgBestFace = document.getElementById('img_BestFace');
    if (imgBestFace) {
        imgBestFace.src = URL.createObjectURL(blob);
        imgBestFace.style.display = 'block'; // 确保显示
    }
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
    // 如果流程不是在等待检测，或者已经完成，则直接返回
    if (state !== 'LIVENESS_CHECK') return;

    // --- 1. 并行检测：眨眼 ---
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const avgEAR = (getEAR(leftEye) + getEAR(rightEye)) / 2;

    if (avgEAR < BLINK_THRESHOLD) {
        blinkCounter++;
    } else {
        if (blinkCounter >= 1) { // 检测到一次完整的“闭眼 -> 睁眼”
            if (bestFace.blob) {
                console.log('Blink detected and best face captured!');
                state = 'COMPLETED';
                updateUI('blink'); // 传入完成的动作
                return; 
            } else {
                statusEl.innerText = 'Blink detected, looking for best frontal face...';
            }
        }
        blinkCounter = 0; 
    }

    // --- 2. 并行检测：张嘴 ---
    const mouth = landmarks.getMouth();
    const mar = getMAR(mouth);
    if (mar > MOUTH_OPEN_THRESHOLD) {
        mouthOpenCounter++;
    } else {
        if (mouthOpenCounter > 2) { // 张嘴持续了一小段时间
            if (bestFace.blob) {
                console.log('Mouth open detected and best face captured!');
                state = 'COMPLETED';
                updateUI('mouth');
                return;
            } else {
                statusEl.innerText = 'Mouth open detected, looking for best frontal face...';
            }
        }
        mouthOpenCounter = 0;
    }

    // --- 3. 并行检测：摇头 ---
    const nose = landmarks.getNose();
    const noseTip = nose[3];
    const jaw = landmarks.getJawOutline();
    const faceLeft = jaw[0].x;
    const faceRight = jaw[16].x;
    const faceWidth = faceRight - faceLeft;
    const noseRelX = (noseTip.x - faceLeft) / faceWidth;

    if (noseRelX < 0.4) { // 向左看
        headShakeData.left = Date.now();
    }
    if (noseRelX > 0.6) { // 向右看
        headShakeData.right = Date.now();
    }

    // 如果在短时间内（2秒内）检测到了向左和向右的动作
    if (headShakeData.left && headShakeData.right && Math.abs(headShakeData.left - headShakeData.right) < 2000) {
        if (bestFace.blob) {
            console.log('Shake detected and best face captured!');
            state = 'COMPLETED';
            updateUI('shake');
            return;
        } else {
            statusEl.innerText = 'Shake detected, looking for best frontal face...';
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
restartBtn.addEventListener('click', () => {
    // 重新开始活体检测流程
    startLivenessTest();
    // 隐藏重新开始按钮
    restartBtn.style.display = 'none';
});

// 程序入口：调用初始化函数
init();
