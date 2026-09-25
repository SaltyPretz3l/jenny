"""RapidOCR recognition helpers for scanned PDF pages."""

from __future__ import annotations

import logging
import os
import re
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.ai.tools.builtins.pdf_text import PdfTextLine, _clean_token

RAPID_RENDER_DPI = 200
RAPID_RENDER_DPI_HIGH = 300
UNCERTAIN_SCORE_THRESHOLD = 0.85
MAX_UNCERTAIN_TOKENS = 20
MODEL_FILENAMES = {
    "Det": "PP-OCRv6_det_small.onnx",
    "Cls": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    "Rec": "PP-OCRv6_rec_small.onnx",
}


@dataclass(frozen=True)
class RapidWord:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    score: float


@dataclass(frozen=True)
class UncertainToken:
    line: int
    token: str
    score: float
    alt: str | None


def rapid_ocr_enabled() -> bool:
    return read_environment_value("JENNY_ENABLE_PDF_OCR_RAPID", "1") != "0"


def import_rapidocr() -> Any:
    try:
        import rapidocr  # type: ignore[import-not-found]  # noqa: PLC0415
    except ImportError:
        configured_site_dir = read_environment_value("JENNY_PDF_OCR_SITE_DIR")
        if not configured_site_dir:
            raise
        site_dir = Path(configured_site_dir)
        site_dir_text = str(site_dir)
        if not site_dir.is_dir() or site_dir_text in sys.path:
            raise
        sys.path.append(site_dir_text)
        import rapidocr  # type: ignore[import-not-found]  # noqa: PLC0415

    return rapidocr


def engine_params(models_dir: Path) -> dict[str, object]:
    params: dict[str, object] = {
        "Global.log_level": "warning",
        "EngineConfig.onnxruntime.intra_op_num_threads": max(1, min(4, os.cpu_count() or 1)),
    }
    params.update(
        {
            f"{model_kind}.model_path": str(models_dir / filename)
            for model_kind, filename in MODEL_FILENAMES.items()
        }
    )
    return params


def load_engine() -> Any:
    rapidocr = import_rapidocr()
    models_dir = Path(rapidocr.__file__).parent / "models"
    logging.getLogger("RapidOCR").setLevel(logging.WARNING)
    return rapidocr.RapidOCR(params=engine_params(models_dir))


def render_dpi(page: Any) -> int:
    threshold = float(page.rect.width) / 72 * RAPID_RENDER_DPI
    try:
        if any(float(info["width"]) > threshold for info in page.get_image_info()):
            return RAPID_RENDER_DPI_HIGH
    except Exception:  # noqa: BLE001 - malformed image metadata falls back safely.
        return RAPID_RENDER_DPI
    return RAPID_RENDER_DPI


def page_to_rgb_array(page: Any, *, dpi: int) -> Any:
    import numpy as np  # noqa: PLC0415
    import pymupdf as fitz  # type: ignore[import-not-found]  # noqa: PLC0415

    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)


def _pdf_box(box: Any, *, page: Any, dpi: int) -> tuple[float, float, float, float]:
    scale = dpi / 72
    xs = [float(point[0]) for point in box]
    ys = [float(point[1]) for point in box]
    return (
        min(xs) / scale + float(page.rect.x0),
        min(ys) / scale + float(page.rect.y0),
        max(xs) / scale + float(page.rect.x0),
        max(ys) / scale + float(page.rect.y0),
    )


def _rapid_word(text: Any, score: Any, box: Any, *, page: Any, dpi: int) -> RapidWord | None:
    token = str(text).strip()
    if not token:
        return None
    x0, y0, x1, y1 = _pdf_box(box, page=page, dpi=dpi)
    return RapidWord(x0, y0, x1, y1, token, float(score))


def _split_line_words(
    text: Any,
    score: Any,
    box: Any,
    *,
    page: Any,
    dpi: int,
) -> list[RapidWord]:
    line_text = str(text)
    if not line_text:
        return []
    x0, y0, x1, y1 = _pdf_box(box, page=page, dpi=dpi)
    width = x1 - x0
    length = len(line_text)
    return [
        RapidWord(
            x0 + width * match.start() / length,
            y0,
            x0 + width * match.end() / length,
            y1,
            match.group(),
            float(score),
        )
        for match in re.finditer(r"\S+", line_text)
    ]


def recognize_page(engine: Any, page: Any) -> tuple[list[RapidWord], int]:
    dpi = render_dpi(page)
    image = page_to_rgb_array(page, dpi=dpi)
    result = engine(image, return_word_box=True, text_score=0.5)
    boxes = () if result.boxes is None else result.boxes
    texts = () if result.txts is None else result.txts
    scores = () if result.scores is None else result.scores
    word_results = result.word_results
    words: list[RapidWord] = []
    for index, (box, text, score) in enumerate(zip(boxes, texts, scores, strict=False)):
        line_words = (
            word_results[index]
            if word_results and index < len(word_results) and word_results[index]
            else None
        )
        if line_words is None:
            words.extend(_split_line_words(text, score, box, page=page, dpi=dpi))
            continue
        for word_text, word_score, word_box in line_words:
            word = _rapid_word(word_text, word_score, word_box, page=page, dpi=dpi)
            if word is not None:
                words.append(word)
    return words, dpi


def word_tuples(words: Sequence[RapidWord]) -> list[tuple[Any, ...]]:
    return [(word.x0, word.y0, word.x1, word.y1, word.text, 0, 0, 0) for word in words]


def _has_alphanumeric(text: str) -> bool:
    # Stray punctuation read from leaders or rules is noise, not a figure to verify.
    return any(character.isalnum() for character in text)


def uncertain_tokens(
    words: Sequence[RapidWord],
    lines: Sequence[PdfTextLine],
    *,
    threshold: float = UNCERTAIN_SCORE_THRESHOLD,
    limit: int = MAX_UNCERTAIN_TOKENS,
) -> list[UncertainToken]:
    if not lines or limit <= 0:
        return []
    uncertain = [
        UncertainToken(
            # PdfTextLine.y is the band's top edge (min y0), so compare tops:
            # a word's centre can sit closer to the next band's top than its own.
            line=min(lines, key=lambda line: abs(line.y - word.y0)).number,
            token=word.text,
            score=word.score,
            alt=None,
        )
        for word in words
        if word.score < threshold and _has_alphanumeric(word.text)
    ]
    return sorted(uncertain, key=lambda token: (token.score, token.line))[:limit]


def _matching_word_indices(
    token: UncertainToken,
    words: Sequence[RapidWord],
    used: set[int],
) -> list[int]:
    return [
        index for index, word in enumerate(words) if index not in used and word.text == token.token
    ]


def _tesseract_alternative(
    word: RapidWord,
    tess_words: Sequence[tuple[Any, ...]],
) -> str:
    matches: list[tuple[float, str]] = []
    rapid_width = max(0.0, word.x1 - word.x0)
    for item in tess_words:
        x0, y0, x1, y1, text, _block, _line, _word = item
        tess_x0, tess_y0, tess_x1, tess_y1 = map(float, (x0, y0, x1, y1))
        if not word.y0 <= (tess_y0 + tess_y1) / 2 <= word.y1:
            continue
        overlap = max(0.0, min(word.x1, tess_x1) - max(word.x0, tess_x0))
        narrower = min(rapid_width, max(0.0, tess_x1 - tess_x0))
        token = _clean_token(str(text))
        if token and narrower > 0 and overlap >= 0.5 * narrower:
            matches.append((tess_x0, token))
    return " ".join(text for _x0, text in sorted(matches))


# Alternates this long or longer are checked for one dominant repeated character.
_REPEAT_CHECK_MIN_CHARS = 6


def _plausible_alternative(token: str, alternative: str) -> bool:
    # Tesseract sometimes reads a whole leader or rule over the word's box; such
    # an "alternate" is noise the model would waste reasoning on.
    if len(alternative) > max(2 * len(token), len(token) + 8):
        return False
    if not _has_alphanumeric(alternative):
        return False
    characters = [character for character in alternative if not character.isspace()]
    if len(characters) >= _REPEAT_CHECK_MIN_CHARS:
        character, count = Counter(characters).most_common(1)[0]
        # Digits may repeat legitimately (1,000,000); dots, dashes and l-runs may not.
        if not character.isdigit() and count >= 0.6 * len(characters):
            return False
    return True


def alt_readings(
    uncertain: Sequence[UncertainToken],
    words: Sequence[RapidWord],
    tess_words: Sequence[tuple[Any, ...]],
) -> list[UncertainToken]:
    """Attach Tesseract alternatives, matching repeated primary tokens in word order."""

    used: set[int] = set()
    enriched: list[UncertainToken] = []
    for token in uncertain:
        candidates = _matching_word_indices(token, words, used)
        if not candidates:
            enriched.append(token)
            continue
        index = min(candidates, key=lambda candidate: abs(words[candidate].score - token.score))
        used.add(index)
        alternative = _tesseract_alternative(words[index], tess_words)
        enriched.append(
            replace(token, alt=alternative)
            if alternative
            and alternative != token.token
            and _plausible_alternative(token.token, alternative)
            else token
        )
    return enriched
