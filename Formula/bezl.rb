class Bezl < Formula
  desc "Add device frames to device screen recordings"
  homepage "https://github.com/davidamunga/bezl"
  url "https://registry.npmjs.org/@damunga/bezl/-/bezl-VERSION.tgz"
  sha256 "SHA256_PLACEHOLDER"
  license "MIT"
  version "VERSION"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bezl --version 2>&1")
  end
end
