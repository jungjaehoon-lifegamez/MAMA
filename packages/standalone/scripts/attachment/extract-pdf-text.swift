import Foundation
import PDFKit

guard CommandLine.arguments.count == 3, let maxBytes = Int(CommandLine.arguments[2]), maxBytes > 0 else {
  fputs("usage: extract-pdf-text.swift <pdf-path> <max-output-bytes>\n", stderr)
  exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: url) else {
  fputs("unable to open PDF\n", stderr)
  exit(1)
}

var written = 0
for index in 0..<document.pageCount {
  if let text = document.page(at: index)?.string, !text.isEmpty {
    let separator = written == 0 ? "" : "\n\n"
    let data = (separator + text).data(using: .utf8) ?? Data()
    let remaining = maxBytes - written
    if remaining <= 0 { break }
    let bounded = data.prefix(remaining)
    FileHandle.standardOutput.write(bounded)
    written += bounded.count
    if bounded.count < data.count { break }
  }
}
