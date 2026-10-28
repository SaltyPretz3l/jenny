"""Local CPU speech recognition for push-to-talk dictation.

Electron owns the model download and the microphone; this package only decodes
the audio it is handed and runs Parakeet TDT through ``onnx-asr`` on CPU. It
never fetches model files and never keeps or logs audio.
"""
