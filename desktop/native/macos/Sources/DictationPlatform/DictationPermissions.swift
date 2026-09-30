import AVFoundation
import DictationCore
import Speech

/// The two grants dictation needs: Microphone and Speech Recognition.
/// Reading them never prompts; `request` does (only when the user starts a
/// dictation).
public enum DictationPermissions {
    public static func microphone() -> PermissionState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .undetermined
        @unknown default: return .undetermined
        }
    }

    public static func speech() -> PermissionState {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .undetermined
        @unknown default: return .undetermined
        }
    }

    /// Speech recognition only (a recorded file needs no microphone).
    public static func requestSpeech(_ done: @escaping (PermissionState) -> Void) {
        if speech() == .undetermined {
            SFSpeechRecognizer.requestAuthorization { _ in done(speech()) }
        } else {
            done(speech())
        }
    }

    /// Ask for whatever is still undetermined, microphone first.
    public static func request(_ done: @escaping (PermissionState, PermissionState) -> Void) {
        let askSpeech = {
            if speech() == .undetermined {
                SFSpeechRecognizer.requestAuthorization { _ in done(microphone(), speech()) }
            } else {
                done(microphone(), speech())
            }
        }
        if microphone() == .undetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in askSpeech() }
        } else {
            askSpeech()
        }
    }
}

/// Locales `SFSpeechRecognizer` recognizes on this machine without the
/// network, named in the system language.
public enum DictationLocales {
    public static func system() -> String {
        Locale.current.identifier(.bcp47)
    }

    public static func named(_ locale: Locale) -> DictationLocale {
        let id = locale.identifier(.bcp47)
        return DictationLocale(id: id, name: Locale.current.localizedString(forIdentifier: id) ?? id)
    }

    public static func onDevice() -> [DictationLocale] {
        SFSpeechRecognizer.supportedLocales()
            .filter { SFSpeechRecognizer(locale: $0)?.supportsOnDeviceRecognition == true }
            .map(named)
            .sorted { $0.id < $1.id }
    }
}
