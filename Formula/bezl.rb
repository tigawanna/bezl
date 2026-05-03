class Bezl < Formula
  desc "Add device frames to device screen recordings"
  homepage "https://github.com/davidamunga/bezl"
  url "https://registry.npmjs.org/@damunga/bezl/-/bezl-0.0.2.tgz"
  sha256 "aa8d6371a55f7a433aaaa6cc971a2b70c15d8102b79e20d057c39721137e5c68"
  license "MIT"
  version "0.0.2"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["\#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("\#{bin}/bezl --version 2>&1")
  end
end
