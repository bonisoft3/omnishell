import Foundation

/// iOS multi-touch zone state machine matching `plugins/omnishell/runtime/interpreter/kinetic.js`
/// (`attachTouch`) and `apps/apexrun/tests/touch.ts`.
public struct TouchRect: Sendable, Equatable {
    public let left: Float
    public let top: Float
    public let right: Float
    public let bottom: Float

    public init(left: Float, top: Float, right: Float, bottom: Float) {
        self.left = left
        self.top = top
        self.right = right
        self.bottom = bottom
    }

    public var width: Float { right - left }
    public var height: Float { bottom - top }
    public var centerX: Float { (left + right) * 0.5 }
    public var centerY: Float { (top + bottom) * 0.5 }

    public func contains(x: Float, y: Float) -> Bool {
        return x >= left && x <= right && y >= top && y <= bottom
    }

    public func intersects(_ other: TouchRect) -> Bool {
        return left < other.right && other.left < right && top < other.bottom && other.top < bottom
    }
}

public struct TouchZoneRegion: Sendable, Equatable {
    public let id: String
    public let zones: [String]
    public let tapOnly: Bool
    public let seat: Int
    public let rect: TouchRect

    public init(id: String, zones: [String], tapOnly: Bool, seat: Int, rect: TouchRect) {
        self.id = id
        self.zones = zones
        self.tapOnly = tapOnly
        self.seat = seat
        self.rect = rect
    }
}

public struct SeatTouchCommand: Sendable, Equatable {
    public let up: Bool
    public let down: Bool
    public let left: Bool
    public let right: Bool
    public let nitro: Bool

    public init(up: Bool, down: Bool, left: Bool, right: Bool, nitro: Bool) {
        self.up = up
        self.down = down
        self.left = left
        self.right = right
        self.nitro = nitro
    }
}

public final class TouchZoneDispatcher: @unchecked Sendable {
    public let viewportWidth: Float
    public let viewportHeight: Float
    public let regions: [TouchZoneRegion]

    private var pointerZones: [Int: Set<String>] = [:]
    private var zoneRefCounts: [String: Int] = [:]
    public private(set) var triggeredTapZones: [String] = []
    private var initials: [Character] = ["A", "A", "A"]
    public private(set) var initialsCursor: Int = 0

    public init(viewportWidth: Float, viewportHeight: Float, regions: [TouchZoneRegion]) {
        self.viewportWidth = viewportWidth
        self.viewportHeight = viewportHeight
        self.regions = regions
    }

    public func getInitialsString() -> String {
        return String(initials)
    }

    public func hitTest(x: Float, y: Float) -> TouchZoneRegion? {
        for r in regions.reversed() {
            if r.rect.contains(x: x, y: y) {
                return r
            }
        }
        return nil
    }

    public func pointerDown(pointerId: Int, x: Float, y: Float) {
        if let existing = pointerZones.removeValue(forKey: pointerId) {
            for z in existing {
                releaseZone(z)
            }
        }
        pointerZones[pointerId] = []
        applyHit(pointerId: pointerId, region: hitTest(x: x, y: y), sliding: false)
    }

    public func pointerMove(pointerId: Int, x: Float, y: Float) {
        guard pointerZones[pointerId] != nil else { return }
        applyHit(pointerId: pointerId, region: hitTest(x: x, y: y), sliding: true)
    }

    public func pointerUp(pointerId: Int) {
        guard let prev = pointerZones.removeValue(forKey: pointerId) else { return }
        for z in prev {
            releaseZone(z)
        }
    }

    public func pointerCancel(pointerId: Int) {
        pointerUp(pointerId: pointerId)
    }

    public func isZoneActive(_ zone: String) -> Bool {
        return (zoneRefCounts[zone] ?? 0) > 0
    }

    public func sampleSeatCommand(seat: Int = 1) -> SeatTouchCommand {
        let sfx = seat == 2 ? "-2" : ""
        let brake = isZoneActive("brake\(sfx)")
        let drive = isZoneActive("drive\(sfx)")
        let left = isZoneActive("left\(sfx)")
        let right = isZoneActive("right\(sfx)")
        let nitro = isZoneActive("nitro\(sfx)")
        return SeatTouchCommand(
            up: drive && !brake,
            down: brake,
            left: left && !right,
            right: right && !left,
            nitro: nitro
        )
    }

    public func validateClusterLayout(includeSeat2: Bool) -> [String] {
        var faults: [String] = []
        let seat1 = regions.filter { $0.seat == 1 }
        let seat2 = regions.filter { $0.seat == 2 }

        if includeSeat2 {
            for a in seat1 {
                for b in seat2 {
                    if a.rect.intersects(b.rect) {
                        faults.append("\(a.id) meets \(b.id)")
                    }
                }
            }
        }

        let activeSeats = includeSeat2 ? [seat1, seat2] : [seat1]
        for seatRegions in activeSeats {
            let nitro = seatRegions.first { $0.zones.contains { z in z.hasPrefix("nitro") } }
            let brake = seatRegions.first { $0.zones.contains { z in z.hasPrefix("brake") } }
            let padRegions = seatRegions.filter { $0.zones.contains { z in z.hasPrefix("drive") } }
            if let n = nitro, let b = brake, n.rect.intersects(b.rect) {
                faults.append("seat \(n.seat) nitro meets brake")
            }
            for p in padRegions {
                if let n = nitro, n.rect.intersects(p.rect) {
                    faults.append("seat \(p.seat) nitro meets pad")
                }
                if let b = brake, b.rect.intersects(p.rect) {
                    faults.append("seat \(p.seat) brake meets pad")
                }
            }
            for r in seatRegions {
                if r.rect.left < 0 || r.rect.top < 0 || r.rect.right > viewportWidth || r.rect.bottom > viewportHeight {
                    faults.append("\(r.id) leaves the screen")
                }
            }
        }
        return faults
    }

    private func applyHit(pointerId: Int, region: TouchZoneRegion?, sliding: Bool) {
        let prev = pointerZones[pointerId] ?? []
        if let region = region, region.tapOnly {
            for z in prev { releaseZone(z) }
            pointerZones[pointerId] = []
            if !sliding {
                for z in region.zones {
                    triggeredTapZones.append(z)
                    handleTapZone(z)
                }
            }
            return
        }

        let next = Set(region?.zones ?? [])
        for z in next where !prev.contains(z) {
            pressZone(z)
        }
        for z in prev where !next.contains(z) {
            releaseZone(z)
        }
        pointerZones[pointerId] = next
    }

    private func pressZone(_ zone: String) {
        zoneRefCounts[zone, default: 0] += 1
    }

    private func releaseZone(_ zone: String) {
        let next = (zoneRefCounts[zone] ?? 0) - 1
        if next <= 0 {
            zoneRefCounts.removeValue(forKey: zone)
        } else {
            zoneRefCounts[zone] = next
        }
    }

    private func handleTapZone(_ zone: String) {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        switch zone {
        case "menu-up":
            let cur = alphabet.firstIndex(of: initials[initialsCursor]) ?? 0
            initials[initialsCursor] = alphabet[(cur + 1) % 26]
        case "menu-down":
            let cur = alphabet.firstIndex(of: initials[initialsCursor]) ?? 0
            initials[initialsCursor] = alphabet[(cur + 25) % 26]
        case "menu-right":
            initialsCursor = (initialsCursor + 1) % 3
        case "menu-left":
            initialsCursor = (initialsCursor + 2) % 3
        default:
            break
        }
    }

    public static func standardApexRunLayout(width: Float, height: Float) -> TouchZoneDispatcher {
        let regions: [TouchZoneRegion] = [
            TouchZoneRegion(id: "pad-left-1", zones: ["drive", "left"], tapOnly: false, seat: 1, rect: TouchRect(left: 20, top: height - 160, right: 90, bottom: height - 20)),
            TouchZoneRegion(id: "pad-mid-1", zones: ["drive"], tapOnly: false, seat: 1, rect: TouchRect(left: 90, top: height - 160, right: 130, bottom: height - 20)),
            TouchZoneRegion(id: "pad-right-1", zones: ["drive", "right"], tapOnly: false, seat: 1, rect: TouchRect(left: 130, top: height - 160, right: 200, bottom: height - 20)),
            TouchZoneRegion(id: "nitro-1", zones: ["nitro"], tapOnly: false, seat: 1, rect: TouchRect(left: width - 180, top: height - 160, right: width - 105, bottom: height - 20)),
            TouchZoneRegion(id: "brake-1", zones: ["brake"], tapOnly: false, seat: 1, rect: TouchRect(left: width - 95, top: height - 160, right: width - 20, bottom: height - 20)),

            TouchZoneRegion(id: "nitro-2", zones: ["nitro-2"], tapOnly: false, seat: 2, rect: TouchRect(left: 20, top: 20, right: 95, bottom: 140)),
            TouchZoneRegion(id: "brake-2", zones: ["brake-2"], tapOnly: false, seat: 2, rect: TouchRect(left: 105, top: 20, right: 180, bottom: 140)),
            TouchZoneRegion(id: "pad-left-2", zones: ["drive-2", "left-2"], tapOnly: false, seat: 2, rect: TouchRect(left: width - 200, top: 20, right: width - 130, bottom: 140)),
            TouchZoneRegion(id: "pad-mid-2", zones: ["drive-2"], tapOnly: false, seat: 2, rect: TouchRect(left: width - 130, top: 20, right: width - 90, bottom: 140)),
            TouchZoneRegion(id: "pad-right-2", zones: ["drive-2", "right-2"], tapOnly: false, seat: 2, rect: TouchRect(left: width - 90, top: 20, right: width - 20, bottom: 140)),

            TouchZoneRegion(id: "touch-pause", zones: ["pause"], tapOnly: true, seat: 0, rect: TouchRect(left: 20, top: height - 220, right: 76, bottom: height - 172)),
            TouchZoneRegion(id: "touch-skip", zones: ["skip"], tapOnly: true, seat: 0, rect: TouchRect(left: width - 120, top: height - 220, right: width - 20, bottom: height - 172)),
            TouchZoneRegion(id: "arena-key-up", zones: ["menu-up"], tapOnly: true, seat: 0, rect: TouchRect(left: width * 0.5 - 30, top: height * 0.5 - 80, right: width * 0.5 + 30, bottom: height * 0.5 - 30)),
            TouchZoneRegion(id: "arena-key-down", zones: ["menu-down"], tapOnly: true, seat: 0, rect: TouchRect(left: width * 0.5 - 30, top: height * 0.5 + 30, right: width * 0.5 + 30, bottom: height * 0.5 + 80)),
            TouchZoneRegion(id: "arena-key-left", zones: ["menu-left"], tapOnly: true, seat: 0, rect: TouchRect(left: width * 0.5 - 90, top: height * 0.5 - 25, right: width * 0.5 - 35, bottom: height * 0.5 + 25)),
            TouchZoneRegion(id: "arena-key-right", zones: ["menu-right"], tapOnly: true, seat: 0, rect: TouchRect(left: width * 0.5 + 35, top: height * 0.5 - 25, right: width * 0.5 + 90, bottom: height * 0.5 + 25))
        ]
        return TouchZoneDispatcher(viewportWidth: width, viewportHeight: height, regions: regions)
    }
}
