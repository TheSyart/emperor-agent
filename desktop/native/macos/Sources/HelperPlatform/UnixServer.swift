import Darwin
import Foundation

public enum SocketError: Error {
    case invalidPath, insecureDirectory, alreadyRunning, bindFailed(Int32), listenFailed(Int32)
}

public final class UnixServer {
    public let fd: Int32
    private let path: String
    private let inode: ino_t

    public init(path: String) throws {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard url.path == path, path.hasPrefix("/"),
              path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw SocketError.invalidPath
        }
        let directory = url.deletingLastPathComponent().path
        var dirInfo = stat()
        guard lstat(directory, &dirInfo) == 0,
              dirInfo.st_uid == getuid(),
              dirInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              dirInfo.st_mode & 0o077 == 0 else { throw SocketError.insecureDirectory }

        var oldInfo = stat()
        if lstat(path, &oldInfo) == 0 {
            guard oldInfo.st_uid == getuid(), oldInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) else {
                throw SocketError.alreadyRunning
            }
            let probe = socket(AF_UNIX, SOCK_STREAM, 0)
            defer { if probe >= 0 { close(probe) } }
            if probe >= 0, let address = Self.address(path), Self.connect(probe, address) == 0 {
                throw SocketError.alreadyRunning
            }
            guard errno == ECONNREFUSED else { throw SocketError.alreadyRunning }
            guard unlink(path) == 0 else { throw SocketError.alreadyRunning }
        }

        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw SocketError.bindFailed(errno) }
        let oldMask = umask(0o077)
        defer { umask(oldMask) }
        guard let address = Self.address(path), Self.bind(listener, address) == 0 else {
            let code = errno
            close(listener)
            throw SocketError.bindFailed(code)
        }
        guard chmod(path, 0o600) == 0, listen(listener, 1) == 0 else {
            let code = errno
            close(listener)
            unlink(path)
            throw SocketError.listenFailed(code)
        }
        var created = stat()
        guard lstat(path, &created) == 0 else {
            close(listener)
            throw SocketError.bindFailed(errno)
        }
        fd = listener
        self.path = path
        inode = created.st_ino
    }

    deinit {
        close(fd)
        var current = stat()
        if lstat(path, &current) == 0, current.st_ino == inode,
           current.st_uid == getuid(), current.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) {
            unlink(path)
        }
    }

    public func acceptIfReady(timeoutMilliseconds: Int32) -> Int32? {
        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        guard poll(&descriptor, 1, timeoutMilliseconds) > 0, descriptor.revents & Int16(POLLIN) != 0 else {
            return nil
        }
        let client = Darwin.accept(fd, nil, nil)
        if client < 0 { return nil }
        var enabled: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        var sendTimeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout<timeval>.size))
        return client
    }

    private static func address(_ path: String) -> sockaddr_un? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: bytes)
            buffer[bytes.count] = 0
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return address
    }

    private static func bind(_ fd: Int32, _ address: sockaddr_un) -> Int32 {
        var address = address
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
    }

    private static func connect(_ fd: Int32, _ address: sockaddr_un) -> Int32 {
        var address = address
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
    }
}
