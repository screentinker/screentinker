package com.remotedisplay.player.player

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextUtils
import android.text.TextPaint

/*
 * The full-screen "now playing" card for an audio item (MediaKind): a dark screen with a music note
 * and the track name, centred. The web player's audioCard, drawn into a bitmap so it can sit in the
 * full-screen ImageView with no layout change.
 *
 * The note is DRAWN, not a U+266A glyph: not every TV firmware ships a font that has it, and a tofu
 * box in the middle of a lobby screen is worse than no note at all.
 *
 * Capped at 1280 on the long edge: the card is flat colour and one line of text, so a 4K panel gains
 * nothing from a 33MB bitmap per track, and the TV sticks this runs on are short of memory.
 */
object AudioCard {
    private const val MAX_EDGE = 1280

    fun render(stageW: Int, stageH: Int, title: String): Bitmap {
        var w = stageW.coerceAtLeast(16)
        var h = stageH.coerceAtLeast(16)
        val longEdge = maxOf(w, h)
        if (longEdge > MAX_EDGE) {
            w = (w.toLong() * MAX_EDGE / longEdge).toInt().coerceAtLeast(16)
            h = (h.toLong() * MAX_EDGE / longEdge).toInt().coerceAtLeast(16)
        }
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(Color.rgb(0x11, 0x11, 0x11))
        val vmin = minOf(w, h) / 100f

        // Note: 14vmin tall, at 85% opacity like the web card.
        val noteH = 14f * vmin
        val noteColor = Color.argb(0xD9, 0xDD, 0xDD, 0xDD)
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = noteColor; style = Paint.Style.FILL }
        val textSize = 4f * vmin
        val gap = 3f * vmin
        val blockH = noteH + gap + textSize
        val top = (h - blockH) / 2f
        val cx = w / 2f
        val headW = noteH * 0.42f
        val headH = noteH * 0.30f
        val stemW = maxOf(1f, noteH * 0.07f)
        val headCx = cx - headW * 0.15f
        val headCy = top + noteH - headH / 2f
        c.save()
        c.rotate(-20f, headCx, headCy)
        c.drawOval(RectF(headCx - headW / 2f, headCy - headH / 2f, headCx + headW / 2f, headCy + headH / 2f), p)
        c.restore()
        val stemX = headCx + headW / 2f - stemW
        val stemTop = top
        c.drawRect(stemX, stemTop, stemX + stemW, headCy - headH * 0.1f, p)
        val flag = Path().apply {
            moveTo(stemX + stemW, stemTop)
            cubicTo(stemX + stemW + noteH * 0.10f, stemTop + noteH * 0.18f,
                stemX + stemW + noteH * 0.38f, stemTop + noteH * 0.22f,
                stemX + stemW + noteH * 0.26f, stemTop + noteH * 0.52f)
            cubicTo(stemX + stemW + noteH * 0.30f, stemTop + noteH * 0.32f,
                stemX + stemW + noteH * 0.10f, stemTop + noteH * 0.28f,
                stemX + stemW, stemTop + noteH * 0.24f)
            close()
        }
        c.drawPath(flag, p)

        if (title.isNotEmpty()) {
            val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.rgb(0xDD, 0xDD, 0xDD)
                this.textSize = textSize
                typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
                textAlign = Paint.Align.CENTER
            }
            val line = TextUtils.ellipsize(title, tp, w * 0.8f, TextUtils.TruncateAt.END).toString()
            val baseline = top + noteH + gap + textSize - tp.descent()
            c.drawText(line, cx, baseline, tp)
        }
        return bmp
    }
}
