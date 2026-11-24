// Copyright (C) 2024 The Qt Company Ltd.
// SPDX-License-Identifier: LicenseRef-Qt-Commercial OR LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only

#version 440
#extension GL_GOOGLE_include_directive : enable

#include "uniformbuffer.glsl"
#include "colortransfer.glsl"

layout(location = 0) in vec2 texCoord;
layout(location = 0) out vec4 fragColor;

layout(binding = 1) uniform sampler2D plane1Texture;

void main()
{
    float Y = texture(plane1Texture, texCoord).a;
    vec4 color = vec4(Y, Y, Y, 1.);
    fragColor = ubuf.colorMatrix * color * ubuf.opacity;

#ifdef QMM_OUTPUTSURFACE_LINEAR
    fragColor = convertSRGBToLinear(fragColor);
#endif

    // Clamp output to valid range to account for out-of-range
    // input values and numerical inaccuracies in YUV->RGB conversion
    fragColor = clamp(fragColor, 0.0, 1.0);
}
