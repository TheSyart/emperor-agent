import Darwin
import Foundation
import HelperCore

public enum SocketError: Error {
    case invalidPath, insecureDirectory, notASocket, connectFailed(Int32)
}

/// The Helper's side of the connection (SEC-09): main listens, the Helper
/// connects, but only to a socket of this user inside a directory nobody
/// else can enter. Who is listening is checked next (PeerIdentity) and by
/// main's proof in the handshake.
public enum UnixClient {
    public static func connect(path: String) throws -> Int32 {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard url.path == path, path.hasPrefix("/"),
              path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw SocketError.invalidPath
        }
        var directory = stat()
        guard lstat(url.deletingLastPathComponent().path, &directory) == 0,
              directory.st_uid == getuid(),
              directory.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              directory.st_mode & 0o077 == 0 else { throw SocketError.insecureDirectory }
        var file = stat()
        guard lstat(path, &file) == 0 else { throw SocketError.connectFailed(errno) }
        guard file.st_uid == getuid(), file.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) else {
            throw SocketError.notASocket
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.connectFailed(errno) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            let bytes = Array(path.utf8)
            buffer.copyBytes(from: bytes)
            buffer[bytes.count] = 0
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            let code = errno
            close(fd)
            throw SocketError.connectFailed(code)
        }
        var enabled: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        var sendTimeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout<timeval>.size))
        return fd
    }
}

/// Reads the one-time launch secret main wrote to the Helper's stdin.
public enum LaunchSecretReader {
    public enum Failure: Error { case timeout, closed }

    public static func read(fd: Int32, timeoutMilliseconds: Int32) throws -> Data {
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(Int(timeoutMilliseconds)))
        var line = Data()
        while line.last != 0x0a && line.count < 130 {
            let remaining = ContinuousClock.now.duration(to: deadline)
            guard remaining > .zero else { throw Failure.timeout }
            let milliseconds = Int32(clamping: remaining.components.seconds * 1_000
                + remaining.components.attoseconds / 1_000_000_000_000_000)
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, max(1, milliseconds))
            if ready < 0 && errno == EINTR { continue }
            guard ready > 0 else { throw Failure.timeout }
            var byte: UInt8 = 0
            let count = Darwin.read(fd, &byte, 1)
            if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
            if count == 0 { break }
            guard count == 1 else { throw Failure.closed }
            line.append(byte)
        }
        return try LaunchHandshake.parseSecret(line)
    }
}
