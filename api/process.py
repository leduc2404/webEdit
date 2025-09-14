from http.server import BaseHTTPRequestHandler
import json
import time
import requests
import google.generativeai as genai
import os
import base64
from multipart import parse_form_data

# Hàm để đọc file settings.json một cách an toàn
def load_settings():
    # Đường dẫn tương đối từ file process.py (trong /api) đến file settings.json (ở gốc)
    settings_path = os.path.join(os.path.dirname(__file__), '..', 'settings.json')
    with open(settings_path, 'r', encoding='utf-8') as f:
        return json.load(f)

class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            # --- 1. Tải cấu hình từ file settings.json ---
            settings = load_settings()
            
            # --- 2. Phân tích video được gửi lên từ frontend ---
            content_type = self.headers['Content-Type']
            content_length = int(self.headers['Content-Length'])
            body = self.rfile.read(content_length)
            
            form_data = parse_form_data(
                {'Content-Type': content_type, 'Content-Length': content_length},
                body
            )
            
            video_file = form_data['files']['video'][0]
            video_content = video_file['content']

            # --- 3. Gửi video tới Google Gemini ---
            print("Đang gửi yêu cầu tới Google Gemini...")
            genai.configure(api_key=settings["api_keys"]["google_gemini"])
            model = genai.GenerativeModel(model_name="gemini-1.5-flash")
            
            video_part = {"mime_type": "video/mp4", "data": video_content}
            response = model.generate_content([settings["gemini_settings"]["prompt"], video_part])
            
            hook_text = response.text.strip()
            print(f"Gemini đã tạo hook: '{hook_text}'")

            # --- 4. Gửi hook tới FPT.AI TTS ---
            print("Đang gửi yêu cầu tới FPT.AI TTS...")
            tts_cfg = settings["tts_settings"]
            headers = {
                'api-key': settings["api_keys"]["fpt_ai"], 
                'voice': tts_cfg["voice"], 
                'speed': str(tts_cfg["speed"])
            }
            
            fpt_response = requests.post("https://api.fpt.ai/hmi/tts/v5", headers=headers, data=hook_text.encode('utf-8'))
            fpt_response.raise_for_status()
            
            async_link = fpt_response.json().get('async')
            if not async_link:
                raise ValueError(f"FPT.AI không trả về link tải.")

            print("Yêu cầu TTS thành công! Đang tải audio...")
            audio_content = None
            for _ in range(tts_cfg["max_retries"]):
                audio_response = requests.get(async_link)
                if audio_response.status_code == 200:
                    audio_content = audio_response.content
                    print("Tải audio thành công!")
                    break
                time.sleep(tts_cfg['retry_delay'])
            
            if not audio_content:
                raise TimeoutError("Hết thời gian chờ, không thể tải file audio từ FPT.AI.")

            # --- 5. Trả kết quả về cho Frontend ---
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            response_data = {
                "hookText": hook_text,
                "audioData": base64.b64encode(audio_content).decode('utf-8') # Gửi audio dưới dạng base64
            }
            self.wfile.write(json.dumps(response_data).encode('utf-8'))

        except Exception as e:
            print(f"LỖI TRÊN BACKEND: {e}")
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            error_message = {"error": str(e)}
            self.wfile.write(json.dumps(error_message).encode('utf-8'))