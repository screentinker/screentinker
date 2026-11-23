// Copyright (C) 2024 The Qt Company Ltd.
// SPDX-License-Identifier: LicenseRef-Qt-Commercial OR LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only

#ifndef PERCEPTUAL_QUANTIZER
#define PERCEPTUAL_QUANTIZER

// Convert Rec.709 to linear
vec4 convertRec709ToLinear(vec4 rgba)
{
    const vec4 alphaMinusOne = vec4(0.099, 0.099, 0.099, 0);
    const vec4 alpha = alphaMinusOne + 1.;
    bvec4 cutoff = lessThan(rgba, vec4(0.081));
    vec4 high = pow((rgba + alphaMinusOne)/alpha, vec4(1./0.45));
    vec4 low = rgba/4.5;
    return mix(high, low, cutoff);
}

vec4 convertSRGBToLinear(vec4 sRGB)
{
    // https://en.wikipedia.org/wiki/SRGB
    const bvec3 cutoff = lessThanEqual(sRGB.rgb, vec3(0.04045));
    const vec3 low = sRGB.rgb / 12.92;
    const vec3 high = pow((sRGB.rgb + 0.055) / 1.055, vec3(2.4));
    vec3 linear = mix(high, low, cutoff);
    return vec4(linear, sRGB.a);
}

vec4 convertSRGBFromLinear(vec4 linear)
{
    // https://en.wikipedia.org/wiki/SRGB
    const bvec3 cutoff = lessThanEqual(linear.rgb, vec3(0.0031308));
    const vec3 low = linear.rgb * 12.92;
    const vec3 high = 1.055 * pow(linear.rgb, vec3(1.0 / 2.4f)) - 0.055;
    vec3 sRGB = mix(high, low, cutoff);
    return vec4(sRGB, linear.a);
}

// This uses the PQ transfer function, see also https://en.wikipedia.org/wiki/Perceptual_quantizer
// or https://ieeexplore.ieee.org/document/7291452
const float SDR_LEVEL = 100.;

vec4 convertPQToLinear(vec4 rgba)
{
    const vec4 one_over_m1 = vec4(8192./1305.);
    const vec4 one_over_m2 = vec4(32./2523.);
    const float c1 = 107./128.;
    const float c2 = 2413./128;
    const float c3 = 2392./128.;

    vec4 e = pow(rgba, one_over_m2);
    vec4 num = max(e - c1, 0);
    vec4 den = c2 - c3*e;
    return pow(num/den, one_over_m1)*10000./SDR_LEVEL;
}

vec4 convertPQFromLinear(vec4 rgba)
{
    const float m1 = float(1305./8192.);
    const float m2 = float(2523./32.);
    const float c1 = 107./128.;
    const float c2 = 2413./128;
    const float c3 = 2392./128.;

    rgba *= SDR_LEVEL/10000.;
    vec4 p = pow(rgba, vec4(m1));
    vec4 num = c1 + c2*p;
    vec4 den = 1. + c3*p;
    return pow(num/den, vec4(m2));
}

float convertPQToLinear(float sig)
{
    const float one_over_m1 = float(8192./1305.);
    const float one_over_m2 = float(32./2523.);
    const float c1 = 107./128.;
    const float c2 = 2413./128;
    const float c3 = 2392./128.;

    float e = pow(sig, one_over_m2);
    float num = max(e - c1, 0);
    float den = c2 - c3*e;
    return pow(num/den, one_over_m1)*10000./SDR_LEVEL;
}

float convertPQFromLinear(float sig)
{
    const float m1 = float(1305./8192.);
    const float m2 = float(2523./32.);
    const float c1 = 107./128.;
    const float c2 = 2413./128;
    const float c3 = 2392./128.;

    sig *= SDR_LEVEL/10000.;
    float p = pow(sig, m1);
    float num = c1 + c2*p;
    float den = 1. + c3*p;
    return pow(num/den, m2);
}

// This implements support for HLG transfer functions, see also https://en.wikipedia.org/wiki/Hybrid_log–gamma


vec4 convertHLGToLinear(vec4 rgba, float maxLum)
{
    const float a = 0.17883277;
    const float b = 0.28466892; // = 1 - 4a
    const float c = 0.55991073; // = 0.5 - a ln(4a)

    bvec4 cutoff = lessThan(rgba, vec4(0.5));
    vec4 low = rgba*rgba/3;
    vec4 high = (exp((rgba - c)/a) + b)/12.;
    rgba = mix(high, low, cutoff);

    float lum = dot(rgba, vec4(0.2627, 0.6780, 0.0593, 0.));
    float y = pow(lum, 0.2); // gamma-1 with gamma = 1.2

    rgba *= y*maxLum;
    return rgba;
}

#endif
