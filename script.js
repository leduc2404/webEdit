// Chờ cho đến khi toàn bộ cấu trúc HTML của trang được tải xong
document.addEventListener('DOMContentLoaded', () => {

    // --- Bắt đầu code gốc của bạn từ đây ---

    const { FFmpeg } = FFmpeg;
    const { fetchFile } = FFmpegUtil;

    // --- DOM Elements ---
    const videoInput = document.getElementById('video-input');
    const startBtn = document.getElementById('start-btn');
    const statusMessage = document.getElementById('status-message');
    const progressBar = document.getElementById('progress-bar');
    const outputArea = document.getElementById('output-area');
    const outputVideo = document.getElementById('output-video');
    const downloadLink = document.getElementById('download-link');
    const settingsForm = document.getElementById('settings-form');

    // --- Global State ---
    let ffmpeg;
    let appSettings = {};
    let selectedFile = null;

    // --- Helper Functions ---
    const updateStatus = (message, progress = -1) => {
        statusMessage.textContent = message;
        if (progress >= 0) {
            progressBar.style.width = `${progress}%`;
        }
    };

    // --- Core Logic ---

    // 1. Khởi tạo môi trường
    const initialize = async () => {
        updateStatus('Đang khởi tạo môi trường...');
        ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => console.log(message));
        ffmpeg.on('progress', ({ progress }) => updateStatus('Đang ghép video...', Math.round(progress * 100)));

        try {
            const response = await fetch('settings.json');
            const defaultSettings = await response.json();
            settingsForm.querySelectorAll('[data-key]').forEach(input => {
                const path = input.dataset.key;
                const keys = path.split('.');
                let value = defaultSettings;
                keys.forEach(key => { value = value[key]; });
                input.value = value;
            });
            updateStatus('Sẵn sàng. Vui lòng chọn một video.');
        } catch (error) {
            updateStatus('Lỗi: Không thể tải file settings.json.');
            console.error(error);
        }
    };

    // 2. Xử lý khi người dùng chọn file
    videoInput.addEventListener('change', (e) => {
        selectedFile = e.target.files[0];
        if (selectedFile) {
            document.querySelector('.file-label').textContent = `Đã chọn: ${selectedFile.name}`;
            startBtn.disabled = false;
            outputArea.classList.add('hidden');
        } else {
            startBtn.disabled = true;
        }
    });

    // 3. Bắt đầu quá trình xử lý khi nhấn nút
    startBtn.addEventListener('click', async () => {
        if (!selectedFile) return;

        startBtn.disabled = true;
        videoInput.disabled = true;
        outputArea.classList.add('hidden');

        try {
            updateStatus('Đang gửi video tới backend để xử lý AI...');
            const { hookText, audioData } = await getAiDataFromBackend(selectedFile);
            updateStatus(`AI đã xử lý xong: "${hookText}"`);

            const audioBlob = await (await fetch(`data:audio/mp3;base64,${audioData}`)).blob();

            updateStatus('Đang chuẩn bị ghép video...');
            const outputUrl = await runFfmpeg(selectedFile, audioBlob, hookText);

            outputVideo.src = outputUrl;
            downloadLink.href = outputUrl;
            outputArea.classList.remove('hidden');
            updateStatus('Hoàn thành!');

        } catch (error) {
            console.error(error);
            updateStatus(`Đã xảy ra lỗi: ${error.message}`);
        } finally {
            startBtn.disabled = false;
            videoInput.disabled = false;
        }
    });

    // --- API & FFmpeg Functions ---

    async function getAiDataFromBackend(videoFile) {
        const formData = new FormData();
        formData.append('video', videoFile);

        const response = await fetch('/api/process', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Lỗi từ Backend: ${error.error || 'Không xác định'}`);
        }

        return await response.json();
    }

    async function runFfmpeg(videoFile, audioBlob, hookText) {
        if (!ffmpeg.loaded) {
            updateStatus('Đang tải thư viện FFmpeg (lần đầu)...');
            await ffmpeg.load();
        }
        updateStatus('Đang nạp các file cần thiết...');
        await ffmpeg.writeFile('input.mp4', await fetchFile(videoFile));
        await ffmpeg.writeFile('tts.mp3', await fetchFile(audioBlob));
        await ffmpeg.writeFile('overlay.png', await fetchFile('./assets/bg.png'));
        await ffmpeg.writeFile('logo.png', await fetchFile('./assets/logo.png'));
        await ffmpeg.writeFile('font.otf', await fetchFile('./assets/font.otf'));

        await ffmpeg.exec(['-i', 'tts.mp3', 'tts.wav']);

        const FADE_DURATION = 1.0;
        const FONT_SIZE = 33;
        const TEXT_V_POS_RATIO = 0.82;
        const WRAP_AFTER_CHARS = 30;
        const LINE_SPACING = 11;
        const LOGO_SCALE_RATIO = 0.2;
        const LOGO_V_POS_RATIO = 0.68;
        const LOGO_H_MARGIN_RATIO = 0.73;

        const audioDuration = (audioBlob.size / 16000);
        const fade_start_time = Math.max(0, audioDuration - FADE_DURATION);

        const wrapText = (text, maxChars) => {
            const words = text.split(' ');
            let lines = [];
            let currentLine = "";
            for (const word of words) {
                if (!currentLine) {
                    currentLine = word;
                } else if (currentLine.length + 1 + word.length <= maxChars) {
                    currentLine += " " + word;
                } else {
                    lines.push(currentLine);
                    currentLine = word;
                }
            }
            if (currentLine) lines.push(currentLine);
            return lines.join('\n');
        }

        const text_content_wrapped = wrapText(hookText.toUpperCase(), WRAP_AFTER_CHARS);
        const text_content_escaped = text_content_wrapped.replace(/'/g, `''`);

        const filter_complex = `
            [1:v]scale=iw:ih[bg];
            [bg]drawtext=fontfile=/font.otf:text='${text_content_escaped}':fontsize=${FONT_SIZE}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)*${TEXT_V_POS_RATIO}:line_spacing=${LINE_SPACING}[bg_with_text];
            [3:v]scale=iw*${LOGO_SCALE_RATIO}:-1[logo_scaled];
            [bg_with_text][logo_scaled]overlay=x=main_w-overlay_w-(main_w*${LOGO_H_MARGIN_RATIO}):y=main_h*${LOGO_V_POS_RATIO}-overlay_h[composite_overlay];
            [composite_overlay]fade=t=out:st=${fade_start_time}:d=${FADE_DURATION}:alpha=1[faded_composite];
            [0:v][faded_composite]overlay=0:0:enable='between(t,0,${audioDuration})'[final_v]
        `.trim().replace(/\s+/g, ' ');

        await ffmpeg.exec([
            '-i', 'input.mp4',
            '-i', 'overlay.png',
            '-i', 'tts.wav',
            '-i', 'logo.png',
            '-filter_complex', filter_complex,
            '-map', '[final_v]',
            '-map', '2:a',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
            '-c:a', 'aac', '-b:a', '192k',
            '-pix_fmt', 'yuv420p',
            'output.mp4'
        ]);

        const data = await ffmpeg.readFile('output.mp4');
        return URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
    }

    // Chạy hàm khởi tạo
    initialize();

}); // --- Kết thúc sự kiện DOMContentLoaded ---