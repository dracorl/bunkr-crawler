import mongoose from "mongoose";
import axios from "axios";
import { load } from "cheerio";
import Album from "./models/Album.js";
import File from "./models/File.js";

// Domain listesi
const DOMAINS = [
  "bunkr.ac",
  "bunkr.ci",
  "bunkr.cr",
  "bunkr.fi",
  "bunkr.pk",
  "bunkr.ps",
  "bunkr.si",
  "bunkr.sk",
  "bunkr.ws",
  "bunkr.ax",
  "bunkr.red",
  "bunkr.media",
  "bunkr.site",
];

// MongoDB bağlantısı
const MONGODB_URI =
  "mongodb://engin:%5DdU%C2%A3N16pwO%29dk%5E.Kz1%5E%5EEi4%23%3D@152.70.28.202:27017/bunkr_scraper?authSource=admin";

class AlbumFileScraper {
  constructor() {
    this.currentDomainIndex = 0;
    this.processedAlbums = 0;
    this.processedFiles = 0;
    this.failedAlbums = 0;
    this.domainRotationCount = 0;
    this.isShuttingDown = false;
  }

  async connectDB() {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log("✅ MongoDB bağlantısı başarılı");
    } catch (error) {
      console.error("❌ MongoDB bağlantı hatası:", error);
      throw error;
    }
  }

  // Domain rotasyonu
  getNextDomain() {
    if (this.isShuttingDown) return null;

    const domain = DOMAINS[this.currentDomainIndex];
    this.currentDomainIndex = (this.currentDomainIndex + 1) % DOMAINS.length;

    if (this.currentDomainIndex === 0) {
      this.domainRotationCount++;
      console.log(
        `🔄 Domain listesi başa döndü (${this.domainRotationCount}. tur), 2 saniye bekleniyor...`
      );
      return new Promise((resolve) => {
        setTimeout(() => resolve(domain), 2000);
      });
    }

    return Promise.resolve(domain);
  }

  // Tüm domain'leri deneyerek sayfa çek
  async fetchWithDomainRotation(url) {
    let lastError;
    let triedDomains = [];

    for (let i = 0; i < DOMAINS.length; i++) {
      const domain = DOMAINS[(this.currentDomainIndex + i) % DOMAINS.length];

      try {
        const fullUrl = `https://${domain}${url}`;
        triedDomains.push(domain);
        console.log(
          `🌐 Denenen domain (${i + 1}/${DOMAINS.length}): ${fullUrl}`
        );

        const response = await axios.get(fullUrl, {
          timeout: 15000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          validateStatus: function (status) {
            return status >= 200 && status < 400;
          },
        });

        console.log(`✅ Başarılı: ${domain}`);

        this.currentDomainIndex =
          (this.currentDomainIndex + i + 1) % DOMAINS.length;
        return response.data;
      } catch (error) {
        lastError = error;
        const errorType =
          error.code === "ECONNABORTED"
            ? "Timeout"
            : error.response?.status === 404
            ? "404 Not Found"
            : error.response?.status === 403
            ? "403 Forbidden"
            : error.response?.status
            ? `HTTP ${error.response.status}`
            : error.code;

        console.log(`❌ ${domain} başarısız: ${errorType}`);

        if (i < DOMAINS.length - 1) {
          await this.delay(500);
        }
      }
    }

    console.log(`💥 Tüm domain'ler başarısız: ${triedDomains.join(", ")}`);
    throw new Error(`Tüm domain'ler başarısız: ${lastError?.message}`);
  }

  // Pagination kontrolü
  checkPagination($) {
    const pagination = $(".pagination");

    if (pagination.length === 0) {
      console.log("📄 Tek sayfalı içerik");
      return false;
    }

    const lastPageItem = pagination.find("li:last-child, span:last-child");
    const nextButton = pagination.find(
      'a[rel="next"], .next, [aria-label="next"]'
    );

    const hasNextPage =
      !lastPageItem.hasClass("disabled") || nextButton.length > 0;
    console.log(`📄 ${hasNextPage ? "Sonraki sayfa VAR" : "Son sayfadayız"}`);
    return hasNextPage;
  }

  // Dosya bilgilerini çıkar
  extractSingleFileInfo(element, $, albumLink) {
    try {
      const $item = $(element);

      if (!$item.hasClass("theItem")) {
        return null;
      }

      const fileName = $item.attr("title") || "Bilinmeyen Ad";
      const fileSize =
        $item.find(".theSize").text().trim() || "Bilinmeyen Boyut";
      const downloadLink = $item.find('a[aria-label="download"]').attr("href");

      const $typeSpan = $item.find('span[class*="type-"]');
      let fileType = "Bilinmeyen Tip";
      if ($typeSpan.length) {
        const classList = $typeSpan.attr("class").split(/\s+/);
        const typeClass = classList.find((cls) => cls.startsWith("type-"));
        if (typeClass) {
          fileType = typeClass.replace("type-", "");
        }
      }

      if (!downloadLink) {
        return null;
      }

      return {
        name: fileName,
        type: fileType,
        size: fileSize,
        link: downloadLink,
        albumLink: albumLink,
      };
    } catch (error) {
      console.error("Dosya çıkarma hatası:", error);
      return null;
    }
  }

  // Dosyayı veritabanına kaydet
  async saveSingleFileToDB(fileData) {
    try {
      const existingFile = await File.findOne({ link: fileData.link });
      if (!existingFile) {
        const fileDoc = new File(fileData);
        await fileDoc.save();
        this.processedFiles++;
        return true;
      }
      return false;
    } catch (error) {
      if (error.code === 11000) {
        return false;
      }
      console.error("Dosya kaydetme hatası:", error);
      return false;
    }
  }

  // Tek bir albüm sayfasını işle
  async processAlbumPage(albumLink, page = 1) {
    if (this.isShuttingDown) throw new Error("Shutdown in progress");

    let retryCount = 0;
    const maxRetries = 2;

    while (retryCount <= maxRetries) {
      try {
        let url = albumLink;
        if (page > 1) {
          url += `?page=${page}`;
        }

        console.log(
          `📖 Sayfa ${page} taranıyor (Deneme ${retryCount + 1}/${
            maxRetries + 1
          }): ${url}`
        );
        const html = await this.fetchWithDomainRotation(url);
        const $ = load(html);

        let fileCount = 0;
        const gallery = $("#galleryGrid").children();
        const totalElements = gallery.length;

        console.log(`📄 ${totalElements} dosya bulundu`);

        for (let i = 0; i < totalElements; i++) {
          if (this.isShuttingDown) break;

          const element = gallery[i];
          const fileData = this.extractSingleFileInfo(element, $, albumLink);

          if (fileData) {
            const saved = await this.saveSingleFileToDB(fileData);
            if (saved) fileCount++;
          }
        }

        const hasNextPage = this.checkPagination($);
        console.log(`✅ Sayfa ${page} tamamlandı: ${fileCount} dosya işlendi`);

        return {
          fileCount,
          hasNextPage,
          nextPage: page + 1,
        };
      } catch (error) {
        retryCount++;
        if (retryCount <= maxRetries) {
          console.log(
            `🔄 Yeniden deneyeniyor... (${retryCount}/${maxRetries})`
          );
          await this.delay(1000 * retryCount);
        } else {
          console.error(
            `💥 Sayfa ${page} tüm denemelerde başarısız:`,
            error.message
          );
          throw error;
        }
      }
    }
  }

  // Tüm albüm sayfalarını işle
  async processAllAlbumPages(albumLink) {
    if (this.isShuttingDown) return 0;

    let totalFiles = 0;
    let currentPage = 1;
    let hasMorePages = true;
    let consecutiveEmptyPages = 0;

    console.log(`\n🎵 Albüm işleniyor: ${albumLink}`);

    while (hasMorePages && !this.isShuttingDown) {
      try {
        const result = await this.processAlbumPage(albumLink, currentPage);
        totalFiles += result.fileCount;
        hasMorePages = result.hasNextPage;
        currentPage = result.nextPage;

        if (result.fileCount === 0) {
          consecutiveEmptyPages++;
          if (consecutiveEmptyPages >= 2) {
            console.log(
              "🛑 2 ardışık boş sayfa, albüm tamamlandı olarak işaretleniyor"
            );
            hasMorePages = false;
          }
        } else {
          consecutiveEmptyPages = 0;
        }

        if (hasMorePages) {
          console.log(`➡️  Sonraki sayfaya geçiliyor: ${currentPage}`);
        } else {
          console.log(`🏁 Albümün son sayfasına ulaşıldı`);
        }
      } catch (error) {
        if (!this.isShuttingDown) {
          console.error(`❌ Sayfa ${currentPage} işlenemedi:`, error.message);
        }
        hasMorePages = false;
      }
    }

    if (!this.isShuttingDown) {
      console.log(
        `🎉 Albüm tamamlandı: ${totalFiles} toplam dosya (${
          currentPage - 1
        } sayfa)`
      );
    }
    return totalFiles;
  }

  // Albüm state'ini güncelle
  async updateAlbumState(album, success = true) {
    if (this.isShuttingDown) return;

    try {
      if (success) {
        album.state = true;
        await album.save();
      }
      this.processedAlbums++;
    } catch (error) {
      console.error("Albüm güncelleme hatası:", error);
    }
  }

  // İşlenecek albümleri getir
  async getAlbumsBatch(limit = 3) {
    return await Album.find({ state: false }).limit(limit);
  }

  // Ana işleme fonksiyonu
  async processAlbums() {
    const CONCURRENT_ALBUMS = 2;
    let hasMoreAlbums = true;
    let batchCount = 0;

    console.log("🚀 Albüm işleme başlatılıyor...");
    console.log(`🎯 Aynı anda ${CONCURRENT_ALBUMS} albüm işlenecek`);

    while (hasMoreAlbums && !this.isShuttingDown) {
      batchCount++;
      console.log(`\n📦 Batch ${batchCount} işleniyor...`);

      try {
        const albums = await this.getAlbumsBatch(CONCURRENT_ALBUMS);

        if (albums.length === 0) {
          console.log("✅ Tüm albümler işlendi!");
          hasMoreAlbums = false;
          break;
        }

        console.log(`📁 ${albums.length} albüm işlenecek`);

        const albumPromises = albums.map((album) =>
          this.processAllAlbumPages(album.link)
            .then((fileCount) => {
              this.updateAlbumState(album, true);
              console.log(`✅ ${album.name}: ${fileCount} dosya işlendi`);
              return fileCount;
            })
            .catch((error) => {
              if (!this.isShuttingDown) {
                console.error(`❌ ${album.name}: ${error.message}`);
                this.updateAlbumState(album, false);
                this.failedAlbums++;
              }
              return 0;
            })
        );

        await Promise.all(albumPromises);

        if (!this.isShuttingDown && hasMoreAlbums) {
          console.log(
            `⏳ Batch ${batchCount} tamamlandı, sonraki batch hazırlanıyor...`
          );
          await this.delay(1000);
        }
      } catch (error) {
        if (!this.isShuttingDown) {
          console.error("Batch işleme hatası:", error);
        }
        hasMoreAlbums = false;
      }
    }

    if (!this.isShuttingDown) {
      console.log("\n🎉 TÜM İŞLEMLER TAMAMLANDI!");
      console.log(`✅ Başarılı albümler: ${this.processedAlbums}`);
      console.log(`❌ Başarısız albümler: ${this.failedAlbums}`);
      console.log(`📊 Toplam dosya: ${this.processedFiles}`);
      console.log(`🔄 Toplam domain turu: ${this.domainRotationCount}`);
    }
  }

  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async shutdown() {
    console.log("\n🛑 Program durduruluyor...");
    this.isShuttingDown = true;

    await this.delay(1000);

    await mongoose.connection.close();
    console.log("📊 MongoDB bağlantısı kapatıldı");

    console.log("👋 Program sonlandırıldı");
    process.exit(0);
  }

  async start() {
    try {
      await this.connectDB();

      process.on("SIGINT", () => this.shutdown());
      process.on("SIGTERM", () => this.shutdown());

      await this.processAlbums();
    } catch (error) {
      console.error("Program başlatma hatası:", error);
    } finally {
      if (!this.isShuttingDown) {
        await mongoose.connection.close();
        console.log("📊 MongoDB bağlantısı kapatıldı");
      }
    }
  }
}

// Programı başlat
const scraper = new AlbumFileScraper();
scraper.start();
