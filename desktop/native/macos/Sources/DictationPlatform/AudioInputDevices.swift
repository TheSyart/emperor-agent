import AVFoundation
import AudioToolbox
import CoreAudio
import DictationCore

/// Audio input devices through CoreAudio: their stable UID (what settings
/// store), their name, and which one is the system default. Emperor picks a
/// device by UID; the engine's input unit is pointed at it.
public struct AudioInputDevice: Equatable {
    public let id: AudioDeviceID
    public let uid: String
    public let name: String
}

public enum AudioInputDevices {
    private static func address(
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var where_ = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr,
            let value
        else { return nil }
        return value.takeRetainedValue() as String
    }

    private static func inputChannels(_ device: AudioDeviceID) -> Int {
        var where_ = address(kAudioDevicePropertyStreamConfiguration, scope: kAudioDevicePropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &where_, 0, nil, &size) == noErr, size > 0 else {
            return 0
        }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &where_, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    /// Every device with at least one input channel.
    public static func all() -> [AudioInputDevice] {
        var where_ = address(kAudioHardwarePropertyDevices)
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &where_, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &where_, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            guard inputChannels(id) > 0,
                let uid = string(id, kAudioDevicePropertyDeviceUID),
                let name = string(id, kAudioObjectPropertyName)
            else { return nil }
            return AudioInputDevice(id: id, uid: uid, name: name)
        }
    }

    public static func defaultInput() -> AudioDeviceID? {
        var where_ = address(kAudioHardwarePropertyDefaultInputDevice)
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &where_, 0, nil, &size, &device) == noErr,
            device != 0
        else { return nil }
        return device
    }

    /// The devices as the protocol reports them, the default one marked.
    public static func listed() -> [DictationDevice] {
        let preferred = defaultInput()
        return all().map { DictationDevice(id: $0.uid, name: $0.name, isDefault: $0.id == preferred) }
    }

    public static func find(uid: String) -> AudioInputDevice? {
        all().first { $0.uid == uid }
    }

    /// Point `engine`'s input at `device` (before the engine starts).
    public static func use(_ device: AudioDeviceID, for engine: AVAudioEngine) throws {
        guard let unit = engine.inputNode.audioUnit else {
            throw DictationEngineError.noDevice("没有可用的麦克风输入")
        }
        var id = device
        let status = AudioUnitSetProperty(
            unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
            &id, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else {
            throw DictationEngineError.noDevice("无法切换到选定的麦克风（\(status)）")
        }
    }
}
