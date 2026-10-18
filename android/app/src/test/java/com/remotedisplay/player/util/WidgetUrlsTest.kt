package com.remotedisplay.player.util

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetUrlsTest {
    @Test fun `no capability adds nothing, so every other widget URL is unchanged`() {
        assertEquals("", WidgetUrls.panelFragment(null))
        assertEquals("", WidgetUrls.panelFragment(""))
    }

    @Test fun `a room display capability rides in the fragment, encoded`() {
        assertEquals("#panel=abc-_123", WidgetUrls.panelFragment("abc-_123"))
        assertEquals("#panel=a%2Bb%2Fc%3D", WidgetUrls.panelFragment("a+b/c="))
    }

    @Test fun `#660 the transparent flag is added only when the item asks for it`() {
        assertEquals("", WidgetUrls.transparentParam(false))
        assertEquals("&transparent=1", WidgetUrls.transparentParam(true))
    }

    @Test fun `#660 a cached bundle gets the server's style before head closes, else at the start`() {
        val css = WidgetUrls.TRANSPARENT_CSS
        assertEquals("<html><head><title>x</title>$css</head><body></body></html>",
            WidgetUrls.forceTransparent("<html><head><title>x</title></head><body></body></html>"))
        assertEquals("<HTML><HEAD>$css</HEAD></HTML>", WidgetUrls.forceTransparent("<HTML><HEAD></HEAD></HTML>"))
        assertEquals(css + "<p>no head</p>", WidgetUrls.forceTransparent("<p>no head</p>"))
    }
}
