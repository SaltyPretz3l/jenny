'use strict';

// Pinned speech model for push-to-talk dictation (row 84): NVIDIA Parakeet TDT
// 0.6B v3 (int8 ONNX export, CC-BY-4.0) plus Silero VAD (MIT), both from
// Hugging Face at exact revisions. Every file carries the byte size and sha256
// the download service verifies; nothing here is fetched unpinned.

const ASR_REPO = Object.freeze({
  repo: 'istupakov/parakeet-tdt-0.6b-v3-onnx',
  revision: '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce',
  license: 'CC-BY-4.0',
});
const VAD_REPO = Object.freeze({
  repo: 'istupakov/silero-vad-onnx',
  revision: 'b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6',
  license: 'MIT',
});

const file = (source, subdir, repoPath, bytes, sha256) => Object.freeze({
  repo: source.repo, revision: source.revision, repoPath, subdir, bytes, sha256,
});

const DICTATION_MODEL_FILES = Object.freeze([
  file(ASR_REPO, 'asr', 'encoder-model.int8.onnx', 652183999,
    '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09'),
  file(ASR_REPO, 'asr', 'decoder_joint-model.int8.onnx', 18202004,
    'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70'),
  file(ASR_REPO, 'asr', 'nemo128.onnx', 139764,
    'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f'),
  file(ASR_REPO, 'asr', 'vocab.txt', 93939,
    'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d'),
  file(ASR_REPO, 'asr', 'config.json', 97,
    '666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466'),
  file(VAD_REPO, 'vad', 'silero_vad.onnx', 2327524,
    '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'),
  file(VAD_REPO, 'vad', 'config.json', 30,
    '1094039d370c82889582ba739a3d1caac5754c8b3a17a66a534200c9f72086e2'),
]);

const DICTATION_MODEL_TOTAL_BYTES = DICTATION_MODEL_FILES.reduce((sum, entry) => sum + entry.bytes, 0);

const DICTATION_MODEL_MANIFEST = Object.freeze({
  id: 'parakeet-tdt-0.6b-v3-int8-8f23f0c',
  repos: Object.freeze({ asr: ASR_REPO, vad: VAD_REPO }),
  files: DICTATION_MODEL_FILES,
  totalBytes: DICTATION_MODEL_TOTAL_BYTES,
});

// Path of a manifest file relative to the model directory, always with '/'.
function dictationFileRelativePath(entry) {
  return `${entry.subdir}/${entry.repoPath}`;
}

function dictationFileUrl(entry) {
  const repoPath = entry.repoPath.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${repoPath}`;
}

module.exports = {
  DICTATION_MODEL_MANIFEST,
  DICTATION_MODEL_TOTAL_BYTES,
  dictationFileRelativePath,
  dictationFileUrl,
};
