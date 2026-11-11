# Barcode decoder

The scanner optionally loads `@zxing/library` version `0.21.3` from jsDelivr at runtime.
Project: https://github.com/zxing-js/library (Apache-2.0).
Source/license: https://github.com/zxing-js/library/blob/v0.21.3/LICENSE

The library is not bundled. Its browser API decodes canvas pixels locally. Camera permission is
requested only after clicking Start camera. Typed cart entry and sample files do not require this dependency.

Live-camera decoding uses the same pinned package in `camera-decoder.js`, through its core
`MultiFormatReader` and luminance APIs. It receives transferred frame pixels, not a video element or camera stream.
