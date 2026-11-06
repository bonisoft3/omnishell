package com.pronto.omnishell.kinetic

/**
 * Mobile multi-touch zone state machine matching `plugins/omnishell/runtime/interpreter/kinetic.js`
 * (`attachTouch`) and `apps/apexrun/tests/touch.ts`.
 *
 * Contract:
 *   - Each active finger (`pointerId`) is tracked independently from `pointerDown` through
 *     `pointerMove` to `pointerUp` / `pointerCancel`.
 *   - Sliding between overlapping zones (`"drive left"` -> `"drive right"`) enters new zones
 *     before leaving old ones so shared tokens (`"drive"`) never drop for a frame.
 *   - `tap: true` (`data-touch-tap`) zones fire only on initial `pointerDown` (`sliding == false`);
 *     a thumb that slides from the pad onto `.touch-pause` does NOT pause the race.
 *   - A thumb that drifts off the pad into empty space releases its active zones while keeping
 *     its `pointerId` tracked, so sliding back onto the pad re-activates `"drive"`.
 *   - Seat 1 (`drive`, `left`, `right`, `brake`, `nitro`) and Seat 2 (`drive-2`, `left-2`,
 *     `right-2`, `brake-2`, `nitro-2`) stay strictly isolated on hotseat split/duel screens.
 */
data class TouchRect(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float
) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
    val centerX: Float get() = (left + right) * 0.5f
    val centerY: Float get() = (top + bottom) * 0.5f

    fun contains(x: Float, y: Float): Boolean =
        x >= left && x <= right && y >= top && y <= bottom

    fun intersects(other: TouchRect): Boolean =
        left < other.right && other.left < right && top < other.bottom && other.top < bottom
}

data class TouchZoneRegion(
    val id: String,
    val zones: List<String>,
    val tapOnly: Boolean,
    val seat: Int,
    val rect: TouchRect
)

data class SeatTouchCommand(
    val up: Boolean,
    val down: Boolean,
    val left: Boolean,
    val right: Boolean,
    val nitro: Boolean
)

class TouchZoneDispatcher(
    val viewportWidth: Float,
    val viewportHeight: Float,
    val regions: List<TouchZoneRegion>
) {
    private val pointerZones = HashMap<Int, Set<String>>()
    private val zoneRefCounts = HashMap<String, Int>()
    val triggeredTapZones = mutableListOf<String>()
    private val initials = charArrayOf('A', 'A', 'A')
    var initialsCursor: Int = 0
        private set

    fun getInitialsString(): String = String(initials)

    fun hitTest(x: Float, y: Float): TouchZoneRegion? {
        for (i in regions.indices.reversed()) {
            val r = regions[i]
            if (r.rect.contains(x, y)) {
                return r
            }
        }
        return null
    }

    fun pointerDown(pointerId: Int, x: Float, y: Float) {
        val existing = pointerZones.remove(pointerId)
        if (existing != null) {
            for (z in existing) releaseZone(z)
        }
        pointerZones[pointerId] = emptySet()
        applyHit(pointerId, hitTest(x, y), sliding = false)
    }

    fun pointerMove(pointerId: Int, x: Float, y: Float) {
        if (!pointerZones.containsKey(pointerId)) return
        applyHit(pointerId, hitTest(x, y), sliding = true)
    }

    fun pointerUp(pointerId: Int) {
        val prev = pointerZones.remove(pointerId) ?: return
        for (z in prev) {
            releaseZone(z)
        }
    }

    fun pointerCancel(pointerId: Int) {
        pointerUp(pointerId)
    }

    fun isZoneActive(zone: String): Boolean = (zoneRefCounts[zone] ?: 0) > 0

    fun sampleSeatCommand(seat: Int = 1): SeatTouchCommand {
        val sfx = if (seat == 2) "-2" else ""
        val brake = isZoneActive("brake$sfx")
        val drive = isZoneActive("drive$sfx")
        val left = isZoneActive("left$sfx")
        val right = isZoneActive("right$sfx")
        val nitro = isZoneActive("nitro$sfx")
        return SeatTouchCommand(
            up = drive && !brake,
            down = brake,
            left = left && !right,
            right = right && !left,
            nitro = nitro
        )
    }

    /**
     * Validate that Seat 1 and Seat 2 touch clusters do not overlap each other,
     * controls within each seat do not overlap, and all zones stay inside the viewport.
     */
    fun validateClusterLayout(includeSeat2: Boolean): List<String> {
        val faults = mutableListOf<String>()
        val seat1 = regions.filter { it.seat == 1 }
        val seat2 = regions.filter { it.seat == 2 }

        if (includeSeat2) {
            for (a in seat1) {
                for (b in seat2) {
                    if (a.rect.intersects(b.rect)) {
                        faults.add("${a.id} meets ${b.id}")
                    }
                }
            }
        }

        val activeSeats = if (includeSeat2) listOf(seat1, seat2) else listOf(seat1)
        for (seatRegions in activeSeats) {
            val nitro = seatRegions.find { it.zones.any { z -> z.startsWith("nitro") } }
            val brake = seatRegions.find { it.zones.any { z -> z.startsWith("brake") } }
            val padRegions = seatRegions.filter { it.zones.any { z -> z.startsWith("drive") } }
            if (nitro != null && brake != null && nitro.rect.intersects(brake.rect)) {
                faults.add("seat ${nitro.seat} nitro meets brake")
            }
            for (p in padRegions) {
                if (nitro != null && nitro.rect.intersects(p.rect)) {
                    faults.add("seat ${p.seat} nitro meets pad")
                }
                if (brake != null && brake.rect.intersects(p.rect)) {
                    faults.add("seat ${p.seat} brake meets pad")
                }
            }
            for (r in seatRegions) {
                if (r.rect.left < 0f || r.rect.top < 0f || r.rect.right > viewportWidth || r.rect.bottom > viewportHeight) {
                    faults.add("${r.id} leaves the screen")
                }
            }
        }
        return faults
    }

    private fun applyHit(pointerId: Int, region: TouchZoneRegion?, sliding: Boolean) {
        val prev = pointerZones[pointerId] ?: emptySet()
        if (region != null && region.tapOnly) {
            for (z in prev) releaseZone(z)
            pointerZones[pointerId] = emptySet()
            if (!sliding) {
                for (z in region.zones) {
                    triggeredTapZones.add(z)
                    handleTapZone(z)
                }
            }
            return
        }

        val next = region?.zones?.toSet() ?: emptySet()
        // Enter new zones before leaving old ones so shared tokens ("drive") stay continuous
        for (z in next) {
            if (!prev.contains(z)) {
                pressZone(z)
            }
        }
        for (z in prev) {
            if (!next.contains(z)) {
                releaseZone(z)
            }
        }
        pointerZones[pointerId] = next
    }

    private fun pressZone(zone: String) {
        zoneRefCounts[zone] = (zoneRefCounts[zone] ?: 0) + 1
    }

    private fun releaseZone(zone: String) {
        val n = (zoneRefCounts[zone] ?: 0) - 1
        if (n <= 0) {
            zoneRefCounts.remove(zone)
        } else {
            zoneRefCounts[zone] = n
        }
    }

    private fun handleTapZone(zone: String) {
        when (zone) {
            "menu-up" -> {
                val cur = initials[initialsCursor] - 'A'
                initials[initialsCursor] = ('A'.code + (cur + 1) % 26).toChar()
            }
            "menu-down" -> {
                val cur = initials[initialsCursor] - 'A'
                initials[initialsCursor] = ('A'.code + (cur + 25) % 26).toChar()
            }
            "menu-right" -> {
                initialsCursor = (initialsCursor + 1) % 3
            }
            "menu-left" -> {
                initialsCursor = (initialsCursor + 2) % 3
            }
        }
    }

    companion object {
        /**
         * Build the standard Apex Run touch deck layout for a phone/tablet viewport
         * (landscape or portrait), including Seat 1, Seat 2 (duel), pause, skip, and initials keypad.
         */
        fun standardApexRunLayout(width: Float, height: Float): TouchZoneDispatcher {
            val regions = listOf(
                // Seat 1 (bottom-left pad, bottom-right pedals)
                TouchZoneRegion("pad-left-1", listOf("drive", "left"), false, 1, TouchRect(20f, height - 160f, 90f, height - 20f)),
                TouchZoneRegion("pad-mid-1", listOf("drive"), false, 1, TouchRect(90f, height - 160f, 130f, height - 20f)),
                TouchZoneRegion("pad-right-1", listOf("drive", "right"), false, 1, TouchRect(130f, height - 160f, 200f, height - 20f)),
                TouchZoneRegion("nitro-1", listOf("nitro"), false, 1, TouchRect(width - 180f, height - 160f, width - 105f, height - 20f)),
                TouchZoneRegion("brake-1", listOf("brake"), false, 1, TouchRect(width - 95f, height - 160f, width - 20f, height - 20f)),

                // Seat 2 (top-left pedals, top-right pad — clear of Seat 1 in both landscape and portrait)
                TouchZoneRegion("nitro-2", listOf("nitro-2"), false, 2, TouchRect(20f, 20f, 95f, 140f)),
                TouchZoneRegion("brake-2", listOf("brake-2"), false, 2, TouchRect(105f, 20f, 180f, 140f)),
                TouchZoneRegion("pad-left-2", listOf("drive-2", "left-2"), false, 2, TouchRect(width - 200f, 20f, width - 130f, 140f)),
                TouchZoneRegion("pad-mid-2", listOf("drive-2"), false, 2, TouchRect(width - 130f, 20f, width - 90f, 140f)),
                TouchZoneRegion("pad-right-2", listOf("drive-2", "right-2"), false, 2, TouchRect(width - 90f, 20f, width - 20f, 140f)),

                // Tap-only controls (pause, skip, initials keypad)
                TouchZoneRegion("touch-pause", listOf("pause"), true, 0, TouchRect(20f, height - 220f, 76f, height - 172f)),
                TouchZoneRegion("touch-skip", listOf("skip"), true, 0, TouchRect(width - 120f, height - 220f, width - 20f, height - 172f)),
                TouchZoneRegion("arena-key-up", listOf("menu-up"), true, 0, TouchRect(width * 0.5f - 30f, height * 0.5f - 80f, width * 0.5f + 30f, height * 0.5f - 30f)),
                TouchZoneRegion("arena-key-down", listOf("menu-down"), true, 0, TouchRect(width * 0.5f - 30f, height * 0.5f + 30f, width * 0.5f + 30f, height * 0.5f + 80f)),
                TouchZoneRegion("arena-key-left", listOf("menu-left"), true, 0, TouchRect(width * 0.5f - 90f, height * 0.5f - 25f, width * 0.5f - 35f, height * 0.5f + 25f)),
                TouchZoneRegion("arena-key-right", listOf("menu-right"), true, 0, TouchRect(width * 0.5f + 35f, height * 0.5f - 25f, width * 0.5f + 90f, height * 0.5f + 25f))
            )
            return TouchZoneDispatcher(width, height, regions)
        }
    }
}
