# Long streaming Markdown response

This deterministic fixture is used by the chat timeline Markdown microbenchmark. It is intentionally long, structurally varied, and safe to repeat without external inputs.

## Streaming section 1

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_1`, a [safe link](https://example.com/section-1), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 1.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 1 | bounded fallback |
| incremental renders | 1 | stable-prefix reuse |
| output comparison | 1 | byte-equivalent HTML |

```javascript
function renderSection1(source) {
  return source.length > 0 ? 'incremental-1' : 'full';
}
```

Display math remains guarded while open:

$$
T_1 = P_1 + U_1
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.
## Streaming section 2

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_2`, a [safe link](https://example.com/section-2), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 2.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 2 | bounded fallback |
| incremental renders | 2 | stable-prefix reuse |
| output comparison | 2 | byte-equivalent HTML |

```javascript
function renderSection2(source) {
  return source.length > 0 ? 'incremental-2' : 'full';
}
```

Display math remains guarded while open:

$$
T_2 = P_2 + U_2
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 3

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_3`, a [safe link](https://example.com/section-3), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 3.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 3 | bounded fallback |
| incremental renders | 3 | stable-prefix reuse |
| output comparison | 3 | byte-equivalent HTML |

```javascript
function renderSection3(source) {
  return source.length > 0 ? 'incremental-3' : 'full';
}
```

Display math remains guarded while open:

$$
T_3 = P_3 + U_3
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 4

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_4`, a [safe link](https://example.com/section-4), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 4.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 4 | bounded fallback |
| incremental renders | 4 | stable-prefix reuse |
| output comparison | 4 | byte-equivalent HTML |

```javascript
function renderSection4(source) {
  return source.length > 0 ? 'incremental-4' : 'full';
}
```

Display math remains guarded while open:

$$
T_4 = P_4 + U_4
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 5

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_5`, a [safe link](https://example.com/section-5), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 5.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 5 | bounded fallback |
| incremental renders | 5 | stable-prefix reuse |
| output comparison | 5 | byte-equivalent HTML |

```javascript
function renderSection5(source) {
  return source.length > 0 ? 'incremental-5' : 'full';
}
```

Display math remains guarded while open:

$$
T_5 = P_5 + U_5
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 6

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_6`, a [safe link](https://example.com/section-6), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 6.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 6 | bounded fallback |
| incremental renders | 6 | stable-prefix reuse |
| output comparison | 6 | byte-equivalent HTML |

```javascript
function renderSection6(source) {
  return source.length > 0 ? 'incremental-6' : 'full';
}
```

Display math remains guarded while open:

$$
T_6 = P_6 + U_6
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 7

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_7`, a [safe link](https://example.com/section-7), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 7.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 7 | bounded fallback |
| incremental renders | 7 | stable-prefix reuse |
| output comparison | 7 | byte-equivalent HTML |

```javascript
function renderSection7(source) {
  return source.length > 0 ? 'incremental-7' : 'full';
}
```

Display math remains guarded while open:

$$
T_7 = P_7 + U_7
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 8

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_8`, a [safe link](https://example.com/section-8), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 8.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 8 | bounded fallback |
| incremental renders | 8 | stable-prefix reuse |
| output comparison | 8 | byte-equivalent HTML |

```javascript
function renderSection8(source) {
  return source.length > 0 ? 'incremental-8' : 'full';
}
```

Display math remains guarded while open:

$$
T_8 = P_8 + U_8
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 9

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_9`, a [safe link](https://example.com/section-9), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 9.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 9 | bounded fallback |
| incremental renders | 9 | stable-prefix reuse |
| output comparison | 9 | byte-equivalent HTML |

```javascript
function renderSection9(source) {
  return source.length > 0 ? 'incremental-9' : 'full';
}
```

Display math remains guarded while open:

$$
T_9 = P_9 + U_9
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 10

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_10`, a [safe link](https://example.com/section-10), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 10.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 10 | bounded fallback |
| incremental renders | 10 | stable-prefix reuse |
| output comparison | 10 | byte-equivalent HTML |

```javascript
function renderSection10(source) {
  return source.length > 0 ? 'incremental-10' : 'full';
}
```

Display math remains guarded while open:

$$
T_10 = P_10 + U_10
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.

## Streaming section 11

The renderer receives another append-only chunk and keeps settled prose stable while the active paragraph continues to grow. This fixture deliberately mixes ordinary sentences, punctuation, inline `code_11`, a [safe link](https://example.com/section-11), ==highlighted language==, and <kbd>Ctrl</kbd> so sanitization and prose decoration remain represented in every pass.

> A quiet blockquote records the invariant: previously proven HTML remains unchanged, while uncertain Markdown stays in the tail until its structure can no longer affect earlier output.

- Validate the stable prefix before promotion.
- Keep nested content attached to its parent.
  - Preserve this nested item for section 11.
  - Continue the nested item with enough text to span realistic chunks.
- Fall back to a complete render when the source is replaced.

| Metric | Section | Expected behavior |
| --- | ---: | --- |
| full renders | 11 | bounded fallback |
| incremental renders | 11 | stable-prefix reuse |
| output comparison | 11 | byte-equivalent HTML |

```javascript
function renderSection11(source) {
  return source.length > 0 ? 'incremental-11' : 'full';
}
```

Display math remains guarded while open:

$$
T_11 = P_11 + U_11
$$

The closing paragraph gives the scanner a definite blank-line boundary before the next section. It also adds enough natural-language prose to approximate the long assistant responses seen in coding and visualization workflows without depending on a model, network, or mutable external dataset.
