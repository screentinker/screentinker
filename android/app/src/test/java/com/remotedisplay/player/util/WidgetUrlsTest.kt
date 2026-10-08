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
}
